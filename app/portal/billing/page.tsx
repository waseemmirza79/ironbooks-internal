import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingClient } from "./billing-client";
import { PortalErrorState } from "../error-state";
import {
  getCustomerBillingInfo,
  getCustomerInvoices,
  type StripeBillingInfo,
  type StripeInvoice,
} from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";

export type ServiceTier = "insight" | "discipline" | "vision" | "scale";

export interface TierConfig {
  key: ServiceTier;
  name: string;
  tagline: string;
  monthlyFee: number | null;
  firstMonthFee: number | null;
  revenueCap: string;
  onboardingCall: string;
  color: string;
}

export const TIERS: TierConfig[] = [
  {
    key: "insight",
    name: "Tier 1 – Insight",
    tagline: "Getting your books clean and in order.",
    monthlyFee: 247,
    firstMonthFee: 500,
    revenueCap: "Up to $25K/mo",
    onboardingCall: "1:1 (30 min)",
    color: "teal",
  },
  {
    key: "discipline",
    name: "Tier 2 – Discipline",
    tagline: "Monthly reporting, coaching, and accountability.",
    monthlyFee: 497,
    firstMonthFee: 750,
    revenueCap: "Up to $85K/mo",
    onboardingCall: "1:1 (30 min)",
    color: "blue",
  },
  {
    key: "vision",
    name: "Tier 3 – Vision",
    tagline: "Full financial partnership for growing businesses.",
    monthlyFee: 797,
    firstMonthFee: 1500,
    revenueCap: "Up to $250K/mo",
    onboardingCall: "1:1 (60 min)",
    color: "violet",
  },
  {
    key: "scale",
    name: "Tier 4 – Scale",
    tagline: "Enterprise bookkeeping for high-revenue operations.",
    monthlyFee: null,
    firstMonthFee: null,
    revenueCap: "Above $3M/yr",
    onboardingCall: "Custom",
    color: "navy",
  },
];

export const INCLUDED_FEATURES = [
  "Accrual or cash-basis bookkeeping",
  "Bank and credit card reconciliations",
  "Monthly Profit & Loss and Balance Sheet",
  "AI-generated monthly summaries, human-reviewed",
  "Unlimited Ironbooks app & AI tool access",
  "Weekly group coaching calls (optional)",
  "Email support and monthly action video",
  "1:1 onboarding call with your bookkeeping coach",
];

/**
 * Portal billing page — no QBO required. Resolves identity via session →
 * client_users, then pulls tier + invoices from Stripe using the customer's
 * stripe_customer_id. Tier is derived from the subscription price so it
 * never needs to be set manually.
 */
export default async function BillingPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (profile as any)?.role;
  const isInternal = ["admin", "lead", "bookkeeper", "viewer"].includes(role);

  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const impersonatingClientLinkId = cookieStore.get("ironbooks_impersonate_client_link_id")?.value;

  let clientLinkId: string | null = impersonatingClientLinkId || null;

  if (!clientLinkId) {
    if (isInternal) {
      return (
        <PortalErrorState
          code="not_client"
          message="Billing is a client-facing page. Use impersonation to preview it for a specific client."
        />
      );
    }
    const { data: mapping } = await (service as any)
      .from("client_users")
      .select("client_link_id")
      .eq("user_id", user.id)
      .maybeSingle();
    clientLinkId = mapping?.client_link_id || null;
  }

  if (!clientLinkId) {
    return (
      <PortalErrorState
        code="no_mapping"
        message="Your account isn't linked to a client yet. Your Ironbooks team will send you access soon."
      />
    );
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, stripe_customer_id, billing_start_date, billing_cancel_request_at, billing_cancel_request_note")
    .eq("id", clientLinkId)
    .single();

  if (!clientLink) {
    return <PortalErrorState code="fetch_failed" message="Could not load billing info." />;
  }

  const stripeCustomerId = (clientLink as any).stripe_customer_id as string | null;
  const billingStart = (clientLink as any).billing_start_date as string | null;
  const cancelRequestAt = (clientLink as any).billing_cancel_request_at as string | null;
  const cancelRequestNote = (clientLink as any).billing_cancel_request_note as string | null;
  const coachingCallLink = process.env.STRIPE_COACHING_CALL_PAYMENT_LINK || null;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://app.ironbooks.com";

  // Pull tier + invoices from Stripe. Fail soft — if no customer ID or Stripe
  // is unreachable, the page still renders with a "contact us" fallback.
  let billingInfo: StripeBillingInfo | null = null;
  let invoices: StripeInvoice[] = [];

  if (stripeCustomerId) {
    try {
      [billingInfo, invoices] = await Promise.all([
        getCustomerBillingInfo(stripeCustomerId),
        getCustomerInvoices(stripeCustomerId, 24),
      ]);
    } catch (err: any) {
      console.warn("[billing] Stripe fetch failed:", err.message);
    }
  }

  return (
    <BillingClient
      clientLinkId={clientLinkId}
      clientName={(clientLink as any).client_name}
      tier={billingInfo?.tier ?? null}
      monthlyAmountDollars={billingInfo?.monthlyAmountDollars ?? null}
      subscriptionStatus={billingInfo?.subscriptionStatus ?? null}
      currentPeriodEnd={billingInfo?.currentPeriodEnd ?? null}
      billingStart={billingStart}
      stripeCustomerId={stripeCustomerId}
      invoices={invoices}
      coachingCallLink={coachingCallLink}
      cancelRequestAt={cancelRequestAt}
      cancelRequestNote={cancelRequestNote}
      impersonating={!!impersonatingClientLinkId && isInternal}
      portalReturnUrl={`${baseUrl}/portal/billing`}
    />
  );
}
