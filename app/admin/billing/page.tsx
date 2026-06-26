import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingTable } from "./billing-table";

export const dynamic = "force-dynamic";

/**
 * /admin/billing — IronBooks' subscription revenue, month-by-month, per client.
 * Synced from Stripe (billing_subscriptions + billing_payments, migration 96)
 * with manual entry for non-Stripe methods. Admin/lead only.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const sp = await searchParams;
  const year = Number(sp.year) || new Date().getUTCFullYear();

  const curMonth = new Date().getUTCMonth() + 1;
  const [{ data: clients }, { data: subs }, { data: pays }, { data: reconRows }, { data: unmatchedRows }] = await Promise.all([
    service.from("client_links")
      .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, client_email")
      .eq("is_active", true)
      .order("client_name"),
    (service as any).from("billing_subscriptions").select("*"),
    (service as any).from("billing_payments").select("*").eq("period_year", year),
    (service as any).from("billing_recon_runs").select("*").eq("period_year", year).eq("period_month", curMonth).order("ran_at", { ascending: false }).limit(1),
    (service as any).from("billing_unmatched_charges").select("*").eq("period_year", year).eq("period_month", curMonth).order("amount_cents", { ascending: false }),
  ]);
  const recon = (reconRows as any[])?.[0] || null;
  const unmatched = (unmatchedRows as any[]) || [];

  const subByClient = new Map<string, any>(((subs as any[]) || []).map((s) => [s.client_link_id, s]));
  // Aggregate payments → per client, per month.
  const payAgg = new Map<string, Map<number, { collected: number; failed: number; manual: number }>>();
  for (const p of ((pays as any[]) || [])) {
    if (!payAgg.has(p.client_link_id)) payAgg.set(p.client_link_id, new Map());
    const m = payAgg.get(p.client_link_id)!;
    const cell = m.get(p.period_month) || { collected: 0, failed: 0, manual: 0 };
    if (p.status === "failed") cell.failed += p.amount_cents;
    else if (p.status === "collected") { cell.collected += p.amount_cents; if (p.source === "manual") cell.manual += p.amount_cents; }
    m.set(p.period_month, cell);
  }

  const rows = ((clients as any[]) || []).map((c) => {
    const sub = subByClient.get(c.id);
    const mrrCents = sub ? (sub.manual_mrr_cents ?? sub.mrr_cents ?? 0) : 0;
    const months: Record<number, { collected: number; failed: number; manual: number }> = {};
    const m = payAgg.get(c.id);
    for (let i = 1; i <= 12; i++) months[i] = m?.get(i) || { collected: 0, failed: 0, manual: 0 };
    return {
      clientLinkId: c.id,
      company: c.legal_business_name || c.client_name || "—",
      contact: [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || "—",
      email: c.client_email || null,
      mrrCents,
      currency: (sub?.currency as string) || "usd",
      subStatus: sub?.subscription_status || "none",
      matchMethod: sub?.match_method || null,
      stripeCustomerId: sub?.stripe_customer_id || null,
      months,
    };
  });

  // Current USD→CAD spot rate (server-side fetch; safe fallback if it fails).
  let fxUsdToCad = 1.37;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { next: { revalidate: 3600 } });
    const j = await r.json();
    if (j?.rates?.CAD && Number.isFinite(j.rates.CAD)) fxUsdToCad = j.rates.CAD;
  } catch { /* keep fallback */ }

  const sum = (pred: (r: typeof rows[number]) => boolean, val: (r: typeof rows[number]) => number) =>
    rows.filter(pred).reduce((s, r) => s + val(r), 0);
  const collectedOf = (r: typeof rows[number]) => Object.values(r.months).reduce((a, c) => a + c.collected, 0);
  const totals = {
    expectedUsdCents: sum((r) => r.currency !== "cad", (r) => r.mrrCents),
    expectedCadCents: sum((r) => r.currency === "cad", (r) => r.mrrCents),
    collectedUsdCents: sum((r) => r.currency !== "cad", collectedOf),
    collectedCadCents: sum((r) => r.currency === "cad", collectedOf),
  };

  return (
    <BillingTable
      year={year}
      rows={rows}
      fxUsdToCad={fxUsdToCad}
      totals={totals}
      recon={recon}
      unmatched={unmatched.map((u) => ({
        who: u.who, amountCents: u.amount_cents, currency: u.currency, customerId: u.stripe_customer_id,
      }))}
    />
  );
}
