import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboRequest, fetchAllAccounts, createJournalEntry } from "@/lib/qbo";
import { resolveAccount } from "@/lib/qbo-journal-entry";
import {
  parseTrialBalance,
  diffTrialBalances,
  parseAjes,
  tieOutFiling,
  type TbRow,
  type FilingType,
} from "@/lib/cpa-roundtrip";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * /api/clients/[id]/cpa — the CPA round-trip hub API.
 *
 * GET  → everything the page needs: TB imports (+cached diffs), AJE batches,
 *        filings with live ledger tie-outs.
 * POST → { action, ... }:
 *   import_tb      { as_of_date, label?, csv_text }         parse + store
 *   diff_tb        { import_id, basis? }                    live QBO TB diff (cached on the row)
 *   import_ajes    { label?, csv_text }                     parse + store (NOT posted)
 *   post_ajes      { batch_id }                             post balanced+resolvable entries to QBO
 *   record_filing  { filing_type, period_end, period_start?, filed_amount, note? }
 *   delete_tb      { import_id } · delete_batch { batch_id } · delete_filing { filing_id }
 *
 * Admin/lead only — CPA work is senior-facing. All QBO writes go through the
 * idempotent createJournalEntry (re-posting a batch never duplicates).
 */
async function gate(id: string) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, qbo_realm_id")
    .eq("id", id)
    .single();
  if (!client) return { error: NextResponse.json({ error: "Client not found" }, { status: 404 }) };
  return { user, service, client };
}

/** Live QBO trial balance as of a date, as signed TbRows (debits positive). */
async function fetchQboTrialBalance(
  realmId: string,
  accessToken: string,
  asOfDate: string,
  basis: "Accrual" | "Cash"
): Promise<TbRow[]> {
  const params = new URLSearchParams({
    start_date: "2000-01-01",
    end_date: asOfDate,
    accounting_method: basis,
    minorversion: "70",
  });
  const report: any = await qboRequest(
    realmId,
    accessToken,
    `/reports/TrialBalance?${params.toString()}`,
    { method: "GET" }
  );
  const out: TbRow[] = [];
  const walk = (rows: any[]) => {
    for (const row of rows || []) {
      const cd = row?.ColData;
      if (Array.isArray(cd) && cd.length >= 3 && cd[0]?.value) {
        const name = String(cd[0].value);
        if (!/^total\b/i.test(name)) {
          const debit = Number(cd[1]?.value || 0) || 0;
          const credit = Number(cd[2]?.value || 0) || 0;
          if (debit !== 0 || credit !== 0) {
            out.push({ account: name, amount: Math.round((debit - credit) * 100) / 100 });
          }
        }
      }
      if (row?.Rows?.Row) walk(row.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);
  return out;
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if ("error" in g) return g.error;
  const { service, client } = g;

  const safe = async (p: any) => { try { const { data } = await p; return data || []; } catch { return []; } };
  const [imports, batches, filings] = await Promise.all([
    safe((service as any).from("cpa_tb_imports").select("id, as_of_date, label, row_count, last_diff, created_at").eq("client_link_id", id).order("as_of_date", { ascending: false })),
    safe((service as any).from("cpa_aje_batches").select("id, label, entries, entry_count, posted_count, post_results, created_at, posted_at").eq("client_link_id", id).order("created_at", { ascending: false })),
    safe((service as any).from("tax_filings").select("*").eq("client_link_id", id).order("period_end", { ascending: false })),
  ]);

  // Live ledger tie-outs for the recorded filings (best-effort).
  let tieOuts: any[] = [];
  if ((filings as any[]).length && (client as any).qbo_realm_id) {
    try {
      const token = await getValidToken(id, service as any);
      const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);
      const liabilities = accounts
        .filter((a) => a.Active !== false && /liability|credit card/i.test(a.AccountType))
        .map((a) => ({ name: a.Name, balance: Number(a.CurrentBalance || 0) }));
      tieOuts = (filings as any[]).map((f) => ({
        filing_id: f.id,
        ...tieOutFiling(Number(f.filed_amount), liabilities, f.filing_type as FilingType),
      }));
    } catch { /* QBO offline — filings still listed */ }
  }

  return NextResponse.json({
    company: (client as any).legal_business_name || (client as any).client_name,
    imports,
    batches,
    filings,
    tie_outs: tieOuts,
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const g = await gate(id);
  if ("error" in g) return g.error;
  const { user, service, client } = g;
  const body = await req.json().catch(() => ({} as any));
  const action = String(body.action || "");

  try {
    if (action === "import_tb") {
      const { as_of_date, label, csv_text } = body;
      if (!as_of_date || !csv_text) return NextResponse.json({ error: "as_of_date and csv_text required" }, { status: 400 });
      const { rows, skipped } = parseTrialBalance(String(csv_text));
      if (rows.length === 0) return NextResponse.json({ error: "Couldn't parse any TB rows — expected columns like Account, Debit, Credit (or Account, Balance)." }, { status: 422 });
      const { data, error } = await (service as any)
        .from("cpa_tb_imports")
        .insert({ client_link_id: id, as_of_date, label: label || null, rows, row_count: rows.length, created_by: (user as any).id })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, import_id: data.id, rows: rows.length, skipped });
    }

    if (action === "diff_tb") {
      const { import_id, basis } = body;
      const { data: imp } = await (service as any).from("cpa_tb_imports").select("*").eq("id", import_id).eq("client_link_id", id).single();
      if (!imp) return NextResponse.json({ error: "Import not found" }, { status: 404 });
      if (!(client as any).qbo_realm_id) return NextResponse.json({ error: "Client has no QBO connection" }, { status: 400 });
      const token = await getValidToken(id, service as any);
      const qboTb = await fetchQboTrialBalance(
        (client as any).qbo_realm_id,
        token,
        (imp as any).as_of_date,
        basis === "Cash" ? "Cash" : "Accrual"
      );
      const diff = diffTrialBalances((imp as any).rows as TbRow[], qboTb);
      const cached = { ...diff, basis: basis === "Cash" ? "Cash" : "Accrual", ran_at: new Date().toISOString() };
      await (service as any).from("cpa_tb_imports").update({ last_diff: cached }).eq("id", import_id);
      return NextResponse.json({ ok: true, diff: cached });
    }

    if (action === "import_ajes") {
      const { label, csv_text } = body;
      if (!csv_text) return NextResponse.json({ error: "csv_text required" }, { status: 400 });
      const { entries, skipped } = parseAjes(String(csv_text));
      if (entries.length === 0) return NextResponse.json({ error: "Couldn't parse any AJE lines — expected columns like Entry, Date, Account, Debit, Credit, Memo." }, { status: 422 });
      const { data, error } = await (service as any)
        .from("cpa_aje_batches")
        .insert({ client_link_id: id, label: label || null, entries, entry_count: entries.length, created_by: (user as any).id })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, batch_id: data.id, entries: entries.length, unbalanced: entries.filter((e) => !e.balanced).length, skipped });
    }

    if (action === "post_ajes") {
      const { batch_id } = body;
      const { data: batch } = await (service as any).from("cpa_aje_batches").select("*").eq("id", batch_id).eq("client_link_id", id).single();
      if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
      if (!(client as any).qbo_realm_id) return NextResponse.json({ error: "Client has no QBO connection" }, { status: 400 });
      const token = await getValidToken(id, service as any);
      const accounts = await fetchAllAccounts((client as any).qbo_realm_id, token);

      const results: any[] = [];
      let posted = 0;
      for (const entry of ((batch as any).entries || []) as any[]) {
        const already = ((batch as any).post_results || []).find((r: any) => r.key === entry.key && r.status === "posted");
        if (already) { results.push(already); continue; }
        if (!entry.balanced) {
          results.push({ key: entry.key, status: "skipped", reason: "Entry doesn't balance (debits ≠ credits)" });
          continue;
        }
        // Resolve every line's account; skip the entry if ANY line is ambiguous.
        const lines: Array<{ account_id: string; posting_type: "Debit" | "Credit"; amount: number; description?: string }> = [];
        let unresolved: string | null = null;
        for (const l of entry.lines) {
          const r = resolveAccount(l.account, accounts as any);
          if (!r.ok) { unresolved = l.account; break; }
          if (l.debit > 0) lines.push({ account_id: r.qbo_account_id!, posting_type: "Debit", amount: l.debit, description: l.memo || entry.memo || undefined });
          if (l.credit > 0) lines.push({ account_id: r.qbo_account_id!, posting_type: "Credit", amount: l.credit, description: l.memo || entry.memo || undefined });
        }
        if (unresolved) {
          results.push({ key: entry.key, status: "skipped", reason: `Account "${unresolved}" not found in the client's chart — rename it in the paste or create the account, then re-post.` });
          continue;
        }
        try {
          const je = await createJournalEntry((client as any).qbo_realm_id, token, {
            txn_date: entry.txn_date || new Date().toISOString().slice(0, 10),
            private_note: `CPA AJE ${(batch as any).label || ""} #${entry.key}${entry.memo ? ` — ${entry.memo}` : ""}`.trim(),
            lines,
          });
          results.push({ key: entry.key, status: "posted", qbo_je_id: je?.Id || null });
          posted++;
        } catch (e: any) {
          results.push({ key: entry.key, status: "failed", reason: String(e?.message || e).slice(0, 300) });
        }
      }

      await (service as any)
        .from("cpa_aje_batches")
        .update({ post_results: results, posted_count: ((batch as any).posted_count || 0) + posted, posted_at: new Date().toISOString() })
        .eq("id", batch_id);
      await service.from("audit_log").insert({
        user_id: (user as any).id,
        event_type: "cpa_ajes_posted",
        request_payload: { client_link_id: id, batch_id, posted, results: results.map((r) => ({ key: r.key, status: r.status })) } as any,
      });
      return NextResponse.json({ ok: true, posted, results });
    }

    if (action === "record_filing") {
      const { filing_type, period_end, period_start, filed_amount, note } = body;
      if (!["gst_hst", "source_deductions", "corp_tax"].includes(filing_type) || !period_end || !Number.isFinite(Number(filed_amount))) {
        return NextResponse.json({ error: "filing_type, period_end, filed_amount required" }, { status: 400 });
      }
      const { error } = await (service as any).from("tax_filings").insert({
        client_link_id: id,
        filing_type,
        period_end,
        period_start: period_start || null,
        filed_amount: Number(filed_amount),
        note: note || null,
        created_by: (user as any).id,
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (action === "delete_tb" || action === "delete_batch" || action === "delete_filing") {
      const table = action === "delete_tb" ? "cpa_tb_imports" : action === "delete_batch" ? "cpa_aje_batches" : "tax_filings";
      const rowId = body.import_id || body.batch_id || body.filing_id;
      if (!rowId) return NextResponse.json({ error: "id required" }, { status: 400 });
      // Posted AJE batches stay (audit trail) — everything else deletable.
      if (action === "delete_batch") {
        const { data: b } = await (service as any).from("cpa_aje_batches").select("posted_count").eq("id", rowId).single();
        if ((b as any)?.posted_count > 0) return NextResponse.json({ error: "Batch has posted entries — it stays as the audit trail." }, { status: 409 });
      }
      const { error } = await (service as any).from(table).delete().eq("id", rowId).eq("client_link_id", id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    const missing = /relation .* does not exist/i.test(String(e?.message));
    return NextResponse.json(
      { error: missing ? "Run migration 111 first (cpa_tb_imports / cpa_aje_batches / tax_filings)." : e?.message || "Request failed" },
      { status: missing ? 409 : 500 }
    );
  }
}
