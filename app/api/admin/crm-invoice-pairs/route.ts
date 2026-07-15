import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRequest } from "@/lib/qbo";
import { fetchPLDetailAll } from "@/lib/qbo-reports";
import { analyzeCrmInvoiceRevenue } from "@/lib/crm-invoice-revenue";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/crm-invoice-pairs
 *   { client_link_id: string, start?: "YYYY-MM-DD", end?: "YYYY-MM-DD" }
 *
 * READ-ONLY per-client deposit↔invoice pairing preview for the CRM
 * double-count remediation screen. Recomputes the pairing live from the cash
 * P&L detail, then enriches each paired invoice with its CURRENT QBO state
 * (Balance) so the screen can say which fix applies:
 *
 *   - balance = 0  → "paid_in_qbo": a CRM payment is already applied; the
 *     DEPOSIT is the duplicate leg (fix = repoint the deposit to the payment's
 *     UF/clearing account, or remove the CRM payment and apply the deposit).
 *   - balance > 0  → "open": the deposit was never applied; fix = apply the
 *     deposit to the invoice (A/R + customer) or void the duplicate invoice.
 *
 * No QBO writes here — this is the validation step before any remediation.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  // Read-only analysis: bookkeepers run it as the cleanup Revenue Check step;
  // the WRITE (set revenue mode) stays admin/lead-only in /api/admin/revenue-mode.
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id) {
    return NextResponse.json({ error: "Client not found or no QBO connection" }, { status: 404 });
  }

  try {
    const token = await getValidToken(clientLinkId, service as any);
    const realm = (client as any).qbo_realm_id as string;
    const plDetail = await fetchPLDetailAll(realm, token, start, end, "Cash");
    const report = analyzeCrmInvoiceRevenue(plDetail);

    // Enrich paired invoices with live Balance → which remediation applies.
    const ids = [...new Set(report.pairs.map((p) => p.invoice.txn_id).filter(Boolean))];
    const balanceById = new Map<string, number>();
    const IN_CHUNK = 40;
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const list = ids.slice(i, i + IN_CHUNK).map((id) => `'${id}'`).join(",");
      const q = encodeURIComponent(`SELECT Id, Balance FROM Invoice WHERE Id IN (${list})`);
      try {
        const data = await qboRequest<any>(realm, token, `/query?query=${q}`);
        for (const inv of data?.QueryResponse?.Invoice || []) {
          balanceById.set(String(inv.Id), Number(inv.Balance) || 0);
        }
      } catch (e: any) {
        console.warn(`[crm-invoice-pairs] invoice balance query failed: ${e?.message}`);
      }
    }

    const pairs = report.pairs.map((p) => {
      const balance = balanceById.get(String(p.invoice.txn_id));
      const scenario =
        balance === undefined ? "unknown" : balance <= 0.005 ? "paid_in_qbo" : "open";
      return {
        invoice: p.invoice,
        deposit: p.deposit,
        factor: p.factor,
        tax_label: p.taxLabel,
        same_customer: p.sameCustomer,
        days_apart: p.daysApart,
        confidence: p.confidence,
        invoice_balance: balance ?? null,
        scenario,
      };
    });

    const scenarioCounts = pairs.reduce(
      (a, p) => ((a[p.scenario] = (a[p.scenario] || 0) + 1), a),
      {} as Record<string, number>
    );

    return NextResponse.json({
      client_link_id: clientLinkId,
      client_name: (client as any).client_name,
      revenue_recognition_mode: (client as any).revenue_recognition_mode || "standard",
      window: { start, end },
      summary: {
        invoice_txn_count: report.invoiceTxnCount,
        invoice_income_total: report.invoiceIncomeTotal,
        invoice_by_account: report.invoiceByAccount,
        deposit_count: report.depositCount,
        deposit_income_total: report.depositIncomeTotal,
        pair_count: report.pairs.length,
        paired_invoice_total: report.pairedInvoiceTotal,
        paired_deposit_total: report.pairedDepositTotal,
        flagged: report.flagged,
        reason: report.reason,
        scenario_counts: scenarioCounts,
      },
      pairs,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "QBO pull failed" }, { status: 502 });
  }
}
