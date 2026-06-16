import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BillingClient } from "./billing-client";
import { PortalErrorState } from "../error-state";

export const dynamic = "force-dynamic";

export type ServiceTier = "insight" | "discipline" | "vision" | "scale";

export interface TierConfig {
  key: ServiceTier;
  name: string;
  tagline: string;
  monthlyFee: number | null;    // null = custom
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
 * Portal billing page — no QBO required (the data is from client_links and
 * Stripe, not QuickBooks). Resolves client identity via session → client_users
 * mapping, bypassing the QBO-aware portal context so billing is always
 * accessible even if QBO is temporarily disconnected.
 */
export default async function BillingPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  // Resolve client_link_id from the user's client_users mapping.
  // Supports impersonation cookie too by checking admin role first.
  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (profile as any)?.role;
  const isInternal = ["admin", "lead", "bookkeeper", "viewer"].includes(role);

  // Internal staff shouldn't see their own billing page (they have no client_link).
  // Check the impersonation cookie to let admins preview the billing page.
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
    // Real client: look up via client_users
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
    .select("id, client_name, service_tier, stripe_customer_id, billing_start_date, billing_cancel_request_at, billing_cancel_request_note")
    .eq("id", clientLinkId)
    .single();

  if (!clientLink) {
    return <PortalErrorState code="fetch_failed" message="Could not load billing info." />;
  }

  const tier = ((clientLink as any).service_tier as ServiceTier | null) || null;
  const coachingCallLink = process.env.STRIPE_COACHING_CALL_PAYMENT_LINK || null;
  const stripeCustomerId = (clientLink as any).stripe_customer_id as string | null;
  const billingStart = (clientLink as any).billing_start_date as string | null;
  const cancelRequestAt = (clientLink as any).billing_cancel_request_at as string | null;
  const cancelRequestNote = (clientLink as any).billing_cancel_request_note as string | null;

  return (
    <BillingClient
      clientLinkId={clientLinkId}
      clientName={(clientLink as any).client_name}
      tier={tier}
      billingStart={billingStart}
      stripeCustomerId={stripeCustomerId}
      coachingCallLink={coachingCallLink}
      cancelRequestAt={cancelRequestAt}
      cancelRequestNote={cancelRequestNote}
      impersonating={!!impersonatingClientLinkId && isInternal}
    />
  );
}
