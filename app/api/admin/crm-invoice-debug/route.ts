import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest } from "@/lib/qbo";
import { fetchProfitAndLoss, fetchPLDetailAll } from "@/lib/qbo-reports";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/admin/crm-invoice-debug?client_link_id=X&start=&end=
 *
 * READ-ONLY instrumentation for the CRM invoice/deposit double-count when the
 * cash P&L DETAIL comes back empty (Dominion): shows the same window through
 * four lenses so we can see WHERE the invoices/deposits actually live —
 *   1. P&L summary income lines (cash + accrual)
 *   2. P&L DETAIL row shape (cash + accrual): counts by txn_type / section,
 *      and which income accounts Invoice-type rows hit
 *   3. direct QBO Invoice entity query (count + samples, with line income accts)
 *   4. direct QBO Deposit entity query (count + samples, with line accounts)
 * No writes. Admin / lead.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const clientLinkId = url.searchParams.get("client_link_id") || "";
  const year = new Date().getFullYear();
  const start = url.searchParams.get("start") || `${year}-01-01`;
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) return NextResponse.json({ error: "no QBO" }, { status: 404 });
  const realm = (client as any).qbo_realm_id as string;

  const r2 = (n: number) => Math.round((n || 0) * 100) / 100;
  const incomeLines = (pl: any) =>
    (pl.lineItems || [])
      .filter((l: any) => /income|revenue|sales/i.test(l.group || "") && !/cost of goods|expense/i.test(l.group || ""))
      .map((l: any) => ({ account: l.label, group: l.group, amount: l.amount }));

  const detailShape = (rows: any[]) => {
    const byType: Record<string, { count: number; sum: number }> = {};
    const bySection: Record<string, number> = {};
    const invoiceByAccount: Record<string, { count: number; sum: number }> = {};
    for (const r of rows) {
      const t = r.txn_type || "(blank)";
      (byType[t] ??= { count: 0, sum: 0 });
      byType[t].count++;
      byType[t].sum = r2(byType[t].sum + (r.amount || 0));
      bySection[r.section || "(blank)"] = (bySection[r.section || "(blank)"] || 0) + 1;
      if (/invoice/i.test(r.txn_type || "")) {
        const a = r.account || "(none)";
        (invoiceByAccount[a] ??= { count: 0, sum: 0 });
        invoiceByAccount[a].count++;
        invoiceByAccount[a].sum = r2(invoiceByAccount[a].sum + (r.amount || 0));
      }
    }
    return { rowCount: rows.length, byType, bySection, invoiceByAccount, sample: rows.slice(0, 3) };
  };

  try {
    const token = await getValidToken(clientLinkId, service as any);

    const [plCash, plAccrual, detailCash, detailAccrual] = await Promise.all([
      fetchProfitAndLoss(realm, token, start, end, "Cash"),
      fetchProfitAndLoss(realm, token, start, end, "Accrual"),
      fetchPLDetailAll(realm, token, start, end, "Cash").catch((e) => ({ __err: String(e?.message || e) }) as any),
      fetchPLDetailAll(realm, token, start, end, "Accrual").catch((e) => ({ __err: String(e?.message || e) }) as any),
    ]);

    // Direct entity queries — the robust source.
    const q = (stmt: string) => `/query?query=${encodeURIComponent(stmt)}`;
    let invoices: any = null;
    let deposits: any = null;
    try {
      const invData = await qboRequest<any>(
        realm,
        token,
        q(`SELECT * FROM Invoice WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' ORDERBY TxnDate DESC MAXRESULTS 5`)
      );
      const list = invData?.QueryResponse?.Invoice || [];
      const cntData = await qboRequest<any>(
        realm,
        token,
        q(`SELECT COUNT(*) FROM Invoice WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`)
      );
      invoices = {
        count: cntData?.QueryResponse?.totalCount ?? null,
        sample: list.map((inv: any) => ({
          id: inv.Id,
          doc: inv.DocNumber,
          customer: inv.CustomerRef?.name,
          txnDate: inv.TxnDate,
          total: inv.TotalAmt,
          balance: inv.Balance,
          lines: (inv.Line || [])
            .filter((l: any) => l.DetailType === "SalesItemLineDetail")
            .map((l: any) => ({
              amount: l.Amount,
              item: l.SalesItemLineDetail?.ItemRef?.name,
              desc: l.Description,
            })),
        })),
      };
    } catch (e: any) {
      invoices = { __err: String(e?.message || e) };
    }
    try {
      const depData = await qboRequest<any>(
        realm,
        token,
        q(`SELECT * FROM Deposit WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' ORDERBY TxnDate DESC MAXRESULTS 5`)
      );
      const list = depData?.QueryResponse?.Deposit || [];
      const cntData = await qboRequest<any>(
        realm,
        token,
        q(`SELECT COUNT(*) FROM Deposit WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`)
      );
      deposits = {
        count: cntData?.QueryResponse?.totalCount ?? null,
        sample: list.map((d: any) => ({
          id: d.Id,
          txnDate: d.TxnDate,
          total: d.TotalAmt,
          lines: (d.Line || []).map((l: any) => ({
            amount: l.Amount,
            account: l.DepositLineDetail?.AccountRef?.name,
            entity: l.DepositLineDetail?.Entity?.name,
          })),
        })),
      };
    } catch (e: any) {
      deposits = { __err: String(e?.message || e) };
    }

    return NextResponse.json({
      client: (client as any).client_name,
      window: { start, end },
      summary_income_cash: incomeLines(plCash),
      summary_income_accrual: incomeLines(plAccrual),
      detail_cash: detailCash?.__err ? detailCash : detailShape(detailCash as any[]),
      detail_accrual: detailAccrual?.__err ? detailAccrual : detailShape(detailAccrual as any[]),
      invoices,
      deposits,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "debug pull failed" }, { status: 502 });
  }
}
