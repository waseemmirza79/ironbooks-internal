import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchProfitAndLoss, fetchPLDetailAll } from "@/lib/qbo-reports";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/client-audit   (admin/lead only)
 *   { client_link_id, start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
 *
 * Deep-audit pull for ONE client's period: the full P&L in both bases
 * (summary fields + line items — the same lens the statement snapshot uses)
 * plus the complete transaction-level detail with account context, aggregated
 * per account. Built to diagnose statement-vs-ledger discrepancies (e.g. line
 * items missing from a close snapshot). Read-only.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const b = await request.json().catch(() => ({}));
  const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || "") ? b.start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(b.end || "") ? b.end : null;
  const clientName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  if ((!b.client_link_id && !clientName) || !start || !end) {
    return NextResponse.json({ error: "client_link_id (or client_name), start, end required" }, { status: 400 });
  }

  // Resolve by id, else by name (ilike on either name column). If a name
  // matches more than one active client, list them so the caller can pick.
  let c: any = null;
  if (b.client_link_id) {
    const { data } = await service
      .from("client_links")
      .select("id, client_name, legal_business_name, qbo_realm_id")
      .eq("id", b.client_link_id)
      .single();
    c = data;
  } else {
    const { data: matches } = await (service as any)
      .from("client_links")
      .select("id, client_name, legal_business_name, qbo_realm_id, is_active")
      .or(`client_name.ilike.%${clientName}%,legal_business_name.ilike.%${clientName}%`)
      .eq("is_active", true);
    const list = (matches as any[]) || [];
    if (list.length > 1) {
      return NextResponse.json(
        { error: `"${clientName}" matched ${list.length} clients — use client_link_id`, matches: list.map((m) => ({ id: m.id, name: m.legal_business_name || m.client_name })) },
        { status: 300 }
      );
    }
    c = list[0] || null;
  }
  if (!c || !c.qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }
  const id = c.id;

  try {
    const token = await getValidToken(id, service as any);
    const realm = c.qbo_realm_id;
    // Full P&L both bases (fields + line items) + full transaction detail both
    // bases — the client's provided P&L could be on either basis, so hand over
    // everything to cross-reference against.
    const [plCash, plAccrual, detailCash, detailAccrual] = [
      await fetchProfitAndLoss(realm, token, start, end, "Cash"),
      await fetchProfitAndLoss(realm, token, start, end, "Accrual"),
      await fetchPLDetailAll(realm, token, start, end, "Cash"),
      await fetchPLDetailAll(realm, token, start, end, "Accrual"),
    ];

    const aggregate = (detail: any[]) => {
      const byAccount = new Map<string, { section: string; total: number; count: number }>();
      for (const r of detail) {
        const k = r.account || "(no account)";
        const a = byAccount.get(k) || { section: r.section, total: 0, count: 0 };
        a.total = Math.round((a.total + r.amount) * 100) / 100;
        a.count++;
        byAccount.set(k, a);
      }
      return [...byAccount.entries()].map(([account, a]) => ({ account, ...a })).sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
    };

    // SNAP's own published/closed statement snapshot for the period (what the
    // client was shown), so the ledger, the live P&L, and the sent statement
    // can all be laid side by side.
    const period = start.slice(0, 7); // YYYY-MM
    const { data: run } = await (service as any)
      .from("monthly_rec_runs")
      .select("period, status, statements, attested_at, sent_to_client_at, completed_at, created_at")
      .eq("client_link_id", id)
      .eq("period", period)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const CAP = 8000;
    const plFields = (pl: any) => ({ totalIncome: pl.totalIncome, cogs: pl.cogs, grossProfit: pl.grossProfit, totalExpenses: pl.totalExpenses, netIncome: pl.netIncome, lineItems: pl.lineItems });

    return NextResponse.json({
      company: c.legal_business_name || c.client_name,
      client_link_id: id,
      period,
      start,
      end,
      plCash: plFields(plCash),
      plAccrual: plFields(plAccrual),
      accountsCash: aggregate(detailCash),
      accountsAccrual: aggregate(detailAccrual),
      counts: { cash: detailCash.length, accrual: detailAccrual.length, capped: CAP },
      transactionsCash: detailCash.slice(0, CAP),
      transactionsAccrual: detailAccrual.slice(0, CAP),
      // SNAP's stored May statement (the numbers the client actually received).
      publishedStatement: run
        ? { period: run.period, status: run.status, attested_at: run.attested_at, sent_to_client_at: run.sent_to_client_at, completed_at: run.completed_at, pl: run.statements?.pl ?? null, bs: run.statements?.bs ?? null, cfs: run.statements?.cfs ?? null }
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "QBO pull failed" }, { status: 502 });
  }
}
