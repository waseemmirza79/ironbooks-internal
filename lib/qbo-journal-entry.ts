/**
 * QBO Journal Entry posting + COA-aware account-name resolution.
 *
 * The BS-Cleanup JE suggester emits account "hints" like
 * "Owner Contribution / Equity" or "Interest Expense". To actually POST
 * a JE to QBO we need real account IDs. This module:
 *
 *   1. Resolves each hint to a QBO account ID by:
 *      - exact case-insensitive name match
 *      - then fuzzy match (contains, normalized)
 *      - then subtype/section match for the most common hints
 *        (Equity / Interest Expense / etc.)
 *   2. POSTs the JE to QBO's /journalentry endpoint with proper
 *      double-entry validation.
 *
 * Returns either a successful JE id, or an UNRESOLVED structure
 * listing which hints couldn't be mapped so the UI can ask the
 * bookkeeper to pick from a dropdown.
 */

import { qboRateLimiter, findByPrivateNoteToken, jeIdempotencyToken } from "./qbo";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options?: { method?: string; body?: string }
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/${realmId}${endpoint}`;
  const res = await fetch(url, {
    method: options?.method || "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options?.body,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status} on ${endpoint}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export interface QBOAccountLite {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType: string | null;
  Classification: string | null;
  Active: boolean;
}

export async function listAllAccountsForJE(
  realmId: string,
  accessToken: string
): Promise<QBOAccountLite[]> {
  const query = encodeURIComponent(`SELECT * FROM Account MAXRESULTS 1000`);
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const all: any[] = data?.QueryResponse?.Account || [];
  return all
    .filter((a) => a.Active !== false)
    .map((a) => ({
      Id: a.Id,
      Name: a.Name,
      AccountType: a.AccountType,
      AccountSubType: a.AccountSubType || null,
      Classification: a.Classification || null,
      Active: a.Active !== false,
    }));
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ResolveAccountResult {
  ok: boolean;
  qbo_account_id?: string;
  qbo_account_name?: string;
  candidates?: QBOAccountLite[]; // when ambiguous or no match
  reason?: string;
}

/**
 * Resolve a JE-suggestion account hint to a real QBO account.
 * Strategy:
 *   1. Exact (normalized) name match — usually wins for hints like
 *      "Visa Plat" or "Chase Checking".
 *   2. Contains-match — "Owner Contribution / Equity" matches accounts
 *      named "Owner's Equity" or "Owner Contribution".
 *   3. Heuristic by hint keywords — fallback for generic hints.
 *
 * Returns ok=false with candidates when ambiguous.
 */
export function resolveAccount(
  hint: string,
  accounts: QBOAccountLite[]
): ResolveAccountResult {
  const hintNorm = normalize(hint);
  if (!hintNorm) return { ok: false, reason: "Empty hint" };

  // 1. Exact normalized
  const exact = accounts.filter((a) => normalize(a.Name) === hintNorm);
  if (exact.length === 1) {
    return { ok: true, qbo_account_id: exact[0].Id, qbo_account_name: exact[0].Name };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      candidates: exact,
      reason: `${exact.length} accounts share the exact name "${hint}". Pick one.`,
    };
  }

  // 2. Contains match (either direction)
  const contains = accounts.filter((a) => {
    const an = normalize(a.Name);
    return an.includes(hintNorm) || hintNorm.includes(an);
  });
  if (contains.length === 1) {
    return { ok: true, qbo_account_id: contains[0].Id, qbo_account_name: contains[0].Name };
  }

  // 3. Hint-keyword heuristics for the most common JE suggester outputs.
  const hintLower = hint.toLowerCase();
  const candidatesByKeyword: QBOAccountLite[] = [];

  function matchType(types: string[], nameContains?: string[]) {
    for (const a of accounts) {
      if (!types.includes(a.AccountType)) continue;
      if (nameContains) {
        const an = a.Name.toLowerCase();
        if (!nameContains.some((kw) => an.includes(kw))) continue;
      }
      candidatesByKeyword.push(a);
    }
  }

  if (hintLower.includes("owner") && hintLower.includes("equity")) {
    matchType(["Equity"], ["owner", "equity"]);
  } else if (hintLower.includes("owner") && (hintLower.includes("draw") || hintLower.includes("distribution"))) {
    matchType(["Equity"], ["draw", "distribution"]);
  } else if (hintLower.includes("owner") && hintLower.includes("contribution")) {
    matchType(["Equity"], ["contribution", "investment", "capital"]);
  } else if (hintLower.includes("interest") && hintLower.includes("expense")) {
    matchType(["Expense", "Other Expense"], ["interest"]);
  } else if (hintLower.includes("reconciliation") || hintLower.includes("plug")) {
    matchType(["Other Expense", "Other Income"], ["reconciliation", "discrepancy"]);
  }

  // Dedupe candidatesByKeyword + add contains-results as backup
  const uniqueById = new Map<string, QBOAccountLite>();
  for (const a of [...candidatesByKeyword, ...contains]) {
    uniqueById.set(a.Id, a);
  }
  const allCandidates = Array.from(uniqueById.values());

  if (allCandidates.length === 1) {
    return {
      ok: true,
      qbo_account_id: allCandidates[0].Id,
      qbo_account_name: allCandidates[0].Name,
    };
  }
  if (allCandidates.length > 1) {
    return {
      ok: false,
      candidates: allCandidates,
      reason: `Multiple QBO accounts could match "${hint}". Pick one.`,
    };
  }

  return {
    ok: false,
    reason: `No QBO account matches "${hint}". Create one in QBO, or pick a substitute.`,
  };
}

export interface JEPostLine {
  qbo_account_id: string;
  side: "debit" | "credit";
  amount: number;
  description?: string;
}

export interface JEPostResult {
  qbo_je_id: string;
  doc_number: string | null;
  txn_date: string;
}

/**
 * Post a journal entry to QBO. Validates that debits == credits before
 * sending. Returns the created JE's id + doc number.
 */
export async function createJournalEntry(
  realmId: string,
  accessToken: string,
  lines: JEPostLine[],
  txnDate: string,
  privateNote: string
): Promise<JEPostResult> {
  if (lines.length < 2) {
    throw new Error("A journal entry needs at least two lines.");
  }
  const totalDebit = lines
    .filter((l) => l.side === "debit")
    .reduce((s, l) => s + Math.abs(l.amount), 0);
  const totalCredit = lines
    .filter((l) => l.side === "credit")
    .reduce((s, l) => s + Math.abs(l.amount), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(
      `Debits ($${totalDebit.toFixed(2)}) and credits ($${totalCredit.toFixed(2)}) must balance.`
    );
  }

  // Idempotency: skip the POST if this exact JE was already created on a
  // prior attempt (transient-error retry, double-submit) and return it.
  const idemToken = jeIdempotencyToken({
    realmId,
    txnDate,
    note: privateNote,
    lines: lines.map((l) => ({
      accountId: l.qbo_account_id,
      postingType: l.side === "debit" ? "Debit" : "Credit",
      amount: l.amount,
    })),
  });
  const existingId = await findByPrivateNoteToken(realmId, accessToken, "JournalEntry", idemToken);
  if (existingId) {
    console.warn(`[createJournalEntry] idempotent hit — JE ${existingId} already posted for ${idemToken}; not duplicating.`);
    const existing: any = await qboRequest(
      realmId,
      accessToken,
      `/journalentry/${existingId}?minorversion=70`,
      { method: "GET" }
    );
    const je = existing?.JournalEntry;
    return {
      qbo_je_id: String(je?.Id || existingId),
      doc_number: je?.DocNumber || null,
      txn_date: je?.TxnDate || txnDate,
    };
  }

  const body = {
    TxnDate: txnDate,
    PrivateNote: `[${idemToken}] ${privateNote}`.trim().slice(0, 4000),
    Line: lines.map((l) => ({
      DetailType: "JournalEntryLineDetail",
      Amount: Number(Math.abs(l.amount).toFixed(2)),
      Description: (l.description || "Ironbooks BS reconciliation adjustment").slice(0, 4000),
      JournalEntryLineDetail: {
        PostingType: l.side === "debit" ? "Debit" : "Credit",
        AccountRef: { value: l.qbo_account_id },
      },
    })),
  };

  const data: any = await qboRequest(
    realmId,
    accessToken,
    `/journalentry?minorversion=70`,
    { method: "POST", body: JSON.stringify(body) }
  );

  const je = data?.JournalEntry;
  if (!je?.Id) {
    throw new Error("QBO did not return a JournalEntry id");
  }
  return {
    qbo_je_id: je.Id,
    doc_number: je.DocNumber || null,
    txn_date: je.TxnDate || txnDate,
  };
}
