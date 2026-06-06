import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  listAllAccountsForJE,
  resolveAccount,
  createJournalEntry,
  type JEPostLine,
} from "@/lib/qbo-journal-entry";

export const dynamic = "force-dynamic";

interface IncomingLine {
  // Either resolved already (qbo_account_id) OR a hint to resolve.
  qbo_account_id?: string;
  account_hint?: string;
  side: "debit" | "credit";
  amount: number;
  description?: string;
}

/**
 * POST /api/balance-sheet/post-je
 *
 * Posts a journal entry to QBO. Accepts lines that are either fully
 * resolved (qbo_account_id specified) OR hint-based (account_hint
 * specified — we map to a QBO account via the resolver).
 *
 * If any hint can't be unambiguously resolved, returns 422 with the
 * unresolved hint(s) and candidate accounts so the UI can ask the
 * bookkeeper to pick.
 *
 * Body:
 *   {
 *     client_link_id: string
 *     lines: IncomingLine[]
 *     txn_date: string                  // YYYY-MM-DD
 *     memo: string
 *     source_recon_id?: string          // optional bank_recon_jobs.id
 *   }
 *
 * Returns:
 *   { ok: true, qbo_je_id, doc_number, txn_date }
 *   OR
 *   { ok: false, unresolved: [{ account_hint, candidates }], reason }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const {
    client_link_id,
    lines,
    txn_date,
    memo,
    source_recon_id,
  } = body || {};

  if (!client_link_id || !Array.isArray(lines) || lines.length < 2 || !txn_date) {
    return NextResponse.json(
      {
        error:
          "Body must include client_link_id, txn_date, and a `lines` array with at least 2 entries (debit + credit).",
      },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", client_link_id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let accessToken: string;
  try {
    accessToken = await getValidToken(client_link_id, service as any);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const realmId = (client as any).qbo_realm_id as string;

  // ── Resolve any hint-based lines to real account IDs ──
  const incoming = lines as IncomingLine[];
  const hintLines = incoming.filter((l) => !l.qbo_account_id && l.account_hint);
  let unresolved: Array<{ account_hint: string; candidates: any[]; reason?: string }> = [];
  const resolvedHints = new Map<string, string>(); // hint → account_id

  if (hintLines.length > 0) {
    let accounts;
    try {
      accounts = await listAllAccountsForJE(realmId, accessToken);
    } catch (err: any) {
      return qboErrorResponse(err);
    }
    for (const h of hintLines) {
      if (!h.account_hint || resolvedHints.has(h.account_hint)) continue;
      const r = resolveAccount(h.account_hint, accounts);
      if (r.ok && r.qbo_account_id) {
        resolvedHints.set(h.account_hint, r.qbo_account_id);
      } else {
        unresolved.push({
          account_hint: h.account_hint,
          candidates: r.candidates || [],
          reason: r.reason,
        });
      }
    }
  }

  if (unresolved.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "Some account hints couldn't be resolved unambiguously.",
        unresolved,
      },
      { status: 422 }
    );
  }

  // Build the final lines array
  const postLines: JEPostLine[] = incoming.map((l) => ({
    qbo_account_id:
      l.qbo_account_id ||
      (l.account_hint ? resolvedHints.get(l.account_hint)! : ""),
    side: l.side,
    amount: Number(l.amount),
    description: l.description,
  }));

  let result;
  try {
    result = await createJournalEntry(
      realmId,
      accessToken,
      postLines,
      txn_date,
      `Ironbooks BS reconciliation. ${memo || ""}`.slice(0, 4000)
    );
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  // Audit log
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "bs_je_posted",
      request_payload: {
        client_link_id,
        client_name: (client as any).client_name,
        qbo_je_id: result.qbo_je_id,
        doc_number: result.doc_number,
        txn_date,
        lines: postLines.map((l) => ({
          qbo_account_id: l.qbo_account_id,
          side: l.side,
          amount: l.amount,
        })),
        memo,
        source_recon_id: source_recon_id || null,
      } as any,
    });
  } catch {
    // non-fatal
  }

  // Stamp the originating bank_recon_jobs row with the JE id (history)
  if (source_recon_id) {
    try {
      await (service as any)
        .from("bank_recon_jobs")
        .update({
          status: "je_posted",
          notes: `JE posted to QBO: ${result.qbo_je_id}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", source_recon_id);
    } catch {
      // non-fatal
    }
  }

  return NextResponse.json({
    ok: true,
    qbo_je_id: result.qbo_je_id,
    doc_number: result.doc_number,
    txn_date: result.txn_date,
  });
}
