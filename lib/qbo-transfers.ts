/**
 * QBO Transfer support
 * --------------------
 * Between-account transfers (QBO `Transfer` entity) are structurally NOT
 * expenses: they carry a top-level `FromAccountRef` / `ToAccountRef` and an
 * `Amount`, with no `AccountBasedExpenseLineDetail` lines. The expense
 * reclassify engine (lib/qbo-reclass.ts) is built entirely around expense
 * line detail, so transfers get their own fetch + write path here rather than
 * being forced through `SUPPORTED_TX_TYPES` (which would drop or mangle them).
 *
 * "Reclassify a transfer" means: change its From and/or To account — e.g. a
 * bank-feed "Online Banking Transfer" QBO auto-matched to the wrong account.
 * The expense engine never sees these (Tough Painting, 2026-07-21: SNAP
 * showed transfers as unmatched because it only queried Bill/Purchase/
 * Expense/VendorCredit).
 */
import { qboRequest } from "./qbo";

export interface TransferRecord {
  id: string;
  sync_token: string;
  date: string; // YYYY-MM-DD
  amount: number;
  from_account_id: string;
  from_account_name: string;
  to_account_id: string;
  to_account_name: string;
  private_note: string;
  /** true when this transfer originated from a bank-feed match (has an
   *  OnlineBankingTxnReference) — the "Online Banking Transfer" case. */
  is_bank_fed: boolean;
}

/**
 * Every QBO `Transfer` in a date range, paged. Read-only.
 */
export async function fetchTransfers(
  realmId: string,
  accessToken: string,
  dateStart: string,
  dateEnd: string
): Promise<{ transfers: TransferRecord[]; pulled: number }> {
  const out: TransferRecord[] = [];
  let pulled = 0;
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const startPosition = page * pageSize + 1;
    const query = encodeURIComponent(
      `SELECT * FROM Transfer WHERE TxnDate >= '${dateStart}' AND TxnDate <= '${dateEnd}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
    const txs: any[] = data?.QueryResponse?.Transfer || [];
    pulled += txs.length;
    for (const t of txs) {
      out.push({
        id: String(t.Id),
        sync_token: String(t.SyncToken ?? ""),
        date: t.TxnDate || "",
        amount: Number(t.Amount) || 0,
        from_account_id: String(t.FromAccountRef?.value || ""),
        from_account_name: String(t.FromAccountRef?.name || ""),
        to_account_id: String(t.ToAccountRef?.value || ""),
        to_account_name: String(t.ToAccountRef?.name || ""),
        private_note: t.PrivateNote || "",
        is_bank_fed: !!t.OnlineBankingTxnReference,
      });
    }
    hasMore = txs.length === pageSize;
    page++;
  }
  return { transfers: out, pulled };
}

export interface TransferCurrent {
  from_account_id: string;
  to_account_id: string;
  private_note: string;
}

export interface TransferReclassParams {
  /** New From account id — omit/null to leave From unchanged. */
  newFromAccountId?: string | null;
  /** New To account id — omit/null to leave To unchanged. */
  newToAccountId?: string | null;
  /** Appended to PrivateNote (once — idempotent). */
  auditMemo: string;
  /** STALE GUARD: only act if the live From account still matches this id. */
  expectedFromAccountId?: string | null;
  /** STALE GUARD: only act if the live To account still matches this id. */
  expectedToAccountId?: string | null;
}

export type TransferPlanAction = "apply" | "noop" | "skip_stale" | "error";

export interface TransferPlan {
  action: TransferPlanAction;
  reason: string;
  from_account_id: string;
  to_account_id: string;
  private_note: string;
}

/**
 * PURE decision core for a transfer reclass — no I/O, fully testable. Given the
 * transfer's current state and the requested change, decides whether to apply,
 * skip (stale), no-op, or error (invalid), and computes the resulting From/To +
 * memo. `reclassifyTransfer` wraps this with the QBO refetch/write.
 */
export function planTransferReclass(
  current: TransferCurrent,
  params: TransferReclassParams
): TransferPlan {
  const curFrom = String(current.from_account_id || "");
  const curTo = String(current.to_account_id || "");
  const base = { from_account_id: curFrom, to_account_id: curTo, private_note: current.private_note || "" };

  // Stale guards — a human (or QBO) moved it since we scanned; never overwrite.
  if (params.expectedFromAccountId != null && curFrom !== String(params.expectedFromAccountId)) {
    return { action: "skip_stale", reason: `From account is now ${curFrom || "(none)"}, expected ${params.expectedFromAccountId} — skipped`, ...base };
  }
  if (params.expectedToAccountId != null && curTo !== String(params.expectedToAccountId)) {
    return { action: "skip_stale", reason: `To account is now ${curTo || "(none)"}, expected ${params.expectedToAccountId} — skipped`, ...base };
  }

  const newFrom = params.newFromAccountId ? String(params.newFromAccountId) : curFrom;
  const newTo = params.newToAccountId ? String(params.newToAccountId) : curTo;

  if (newFrom === curFrom && newTo === curTo) {
    return { action: "noop", reason: "Requested accounts already match — nothing to change", ...base };
  }
  // QBO rejects a transfer whose From and To are the same account.
  if (newFrom && newTo && newFrom === newTo) {
    return { action: "error", reason: `From and To would both be account ${newFrom} — QBO requires distinct accounts`, ...base };
  }
  if (!newFrom || !newTo) {
    return { action: "error", reason: "A transfer needs both a From and a To account", ...base };
  }

  const existing = current.private_note || "";
  const memo = existing.includes(params.auditMemo)
    ? existing
    : (existing ? existing + "\n" : "") + params.auditMemo;

  return { action: "apply", reason: "Move From/To to the requested accounts", from_account_id: newFrom, to_account_id: newTo, private_note: memo };
}

export interface TransferReclassResult {
  ok: boolean;
  id: string;
  action: TransferPlanAction;
  reason: string;
  from_account_id: string;
  to_account_id: string;
}

/**
 * Reclassify one transfer's From/To accounts. WRITES to QBO (full-object
 * update, mirroring reclassifyTransactionLines). Refetches for a fresh
 * SyncToken, applies `planTransferReclass`, and only POSTs on an "apply"
 * plan; noop/skip_stale return ok without writing, error throws.
 *
 * Pass account NAMES when known so QBO stores the readable label; the id is
 * what actually re-points the transfer.
 */
export async function reclassifyTransfer(
  realmId: string,
  accessToken: string,
  params: TransferReclassParams & {
    transferId: string;
    newFromAccountName?: string | null;
    newToAccountName?: string | null;
    /** When true, refetch + plan but do NOT write. Defaults to writing. */
    dryRun?: boolean;
  }
): Promise<TransferReclassResult> {
  const cur: any = (await qboRequest<any>(realmId, accessToken, `/transfer/${params.transferId}`))?.Transfer;
  if (!cur) throw new Error(`Transfer ${params.transferId} not found in QBO (can't reclassify)`);

  const plan = planTransferReclass(
    {
      from_account_id: String(cur.FromAccountRef?.value || ""),
      to_account_id: String(cur.ToAccountRef?.value || ""),
      private_note: cur.PrivateNote || "",
    },
    params
  );

  if (plan.action === "error") throw new Error(plan.reason);
  // Dry-run: return the plan without touching QBO. `ok` reflects that the plan
  // is executable (apply) or a benign no-op/skip — never a silent write.
  if (params.dryRun) {
    return { ok: true, id: params.transferId, action: plan.action, reason: plan.reason, from_account_id: plan.from_account_id, to_account_id: plan.to_account_id };
  }
  if (plan.action !== "apply") {
    return { ok: true, id: params.transferId, action: plan.action, reason: plan.reason, from_account_id: plan.from_account_id, to_account_id: plan.to_account_id };
  }

  const fromChanged = plan.from_account_id !== String(cur.FromAccountRef?.value || "");
  const toChanged = plan.to_account_id !== String(cur.ToAccountRef?.value || "");

  // Full-object update (proven pattern): send the refetched entity back with
  // From/To/PrivateNote overridden. QBO ignores read-only fields it returns.
  const body = {
    ...cur,
    FromAccountRef: {
      value: plan.from_account_id,
      ...(fromChanged
        ? params.newFromAccountName ? { name: params.newFromAccountName } : {}
        : cur.FromAccountRef?.name ? { name: cur.FromAccountRef.name } : {}),
    },
    ToAccountRef: {
      value: plan.to_account_id,
      ...(toChanged
        ? params.newToAccountName ? { name: params.newToAccountName } : {}
        : cur.ToAccountRef?.name ? { name: cur.ToAccountRef.name } : {}),
    },
    PrivateNote: plan.private_note,
  };

  const resp: any = await qboRequest<any>(realmId, accessToken, `/transfer?minorversion=70`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const updated = resp?.Transfer || {};
  const finalFrom = String(updated.FromAccountRef?.value || plan.from_account_id);
  const finalTo = String(updated.ToAccountRef?.value || plan.to_account_id);
  // Confirm from the RESPONSE (avoid the "we said success but QBO didn't change" bug class).
  const ok = finalFrom === plan.from_account_id && finalTo === plan.to_account_id;
  return {
    ok,
    id: params.transferId,
    action: "apply",
    reason: ok ? "Transfer re-pointed" : "QBO response did not reflect the requested accounts",
    from_account_id: finalFrom,
    to_account_id: finalTo,
  };
}
