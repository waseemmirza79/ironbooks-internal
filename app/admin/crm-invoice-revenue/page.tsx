import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ReceiptText } from "lucide-react";
import { CrmInvoiceRevenueClient } from "./crm-invoice-client";

export const dynamic = "force-dynamic";

/**
 * /admin/crm-invoice-revenue — fleet report + remediation screen for the CRM
 * invoice/deposit double-count (the Dominion Painters pattern, inverse of
 * /admin/revenue-integrity): the field CRM pushes invoices that recognize as
 * cash-basis income while the bank deposits paying them are ALSO categorized
 * to revenue.
 *
 * Built to walk through with Lisa (admin OR lead): run the sweep, review each
 * flagged client's deposit↔invoice pairs, and set revenue_recognition_mode =
 * deposits_only per client. Read surface — QBO ledger fixes are the separate
 * guarded remediation step.
 */
export default async function CrmInvoiceRevenuePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/today");

  const { data: rows } = await service
    .from("audit_log")
    .select("created_at, event_type, request_payload")
    .in("event_type", ["crm_invoice_revenue_finding", "crm_invoice_sweep_completed"])
    .order("created_at", { ascending: false })
    .limit(400);

  const all = (rows as any[]) || [];
  const completed = all.find((r) => r.event_type === "crm_invoice_sweep_completed");
  // Newest finding per client.
  const byClient = new Map<string, any>();
  for (const r of all) {
    if (r.event_type !== "crm_invoice_revenue_finding") continue;
    const p = r.request_payload || {};
    if (p.client_link_id && !byClient.has(p.client_link_id)) {
      byClient.set(p.client_link_id, { ...p, found_at: r.created_at });
    }
  }

  // Live modes (a finding stores the mode at scan time — show the CURRENT one).
  const ids = [...byClient.keys()];
  let modeById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: clients } = await (service as any)
      .from("client_links")
      .select("id, revenue_recognition_mode")
      .in("id", ids);
    modeById = new Map(
      ((clients as any[]) || []).map((c) => [c.id, c.revenue_recognition_mode || "standard"])
    );
  }

  const findings = [...byClient.values()]
    .map((f) => ({ ...f, current_mode: modeById.get(f.client_link_id) || "standard" }))
    .sort(
      (a, b) =>
        Number(b.flagged) - Number(a.flagged) ||
        (b.paired_deposit_total || 0) - (a.paired_deposit_total || 0)
    );

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <ReceiptText size={20} className="text-teal" />
        <h1 className="text-xl font-bold text-navy">CRM invoice revenue</h1>
      </div>
      <p className="text-sm text-ink-slate mb-6 max-w-3xl">
        Clients whose CRM pushes invoices into QuickBooks that get recognized as cash-basis income
        while the bank deposits paying them are <em>also</em> categorized to revenue — the same job
        counted twice (found on Dominion Painters). Review the pairs with Lisa, then set flagged
        clients to <strong>cash-deposits-only</strong> revenue. Clients with no invoices never
        appear here — deposits are their correct revenue entry.
      </p>
      <CrmInvoiceRevenueClient
        findings={findings}
        lastCompletedAt={completed?.created_at || null}
        lastWindow={completed?.request_payload?.window || null}
      />
    </div>
  );
}
