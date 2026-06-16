import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { resolvePortalContext } from "@/lib/portal-context";
import { createCustomerPortalSession } from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/billing/customer-portal
 *
 * Creates a Stripe Billing Portal session for the current client and returns
 * the redirect URL. The client-side button POSTs here then navigates to the
 * returned URL — Stripe handles payment method management, then redirects
 * back to returnUrl when the client is done.
 *
 * Blocked for impersonating admins — the portal is scoped to the client's
 * Stripe customer and should only be opened by the actual account holder.
 */
export async function POST(request: Request) {
  let ctx: Awaited<ReturnType<typeof resolvePortalContext>>;
  try {
    ctx = await resolvePortalContext();
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Unauthorized" }, { status: 401 });
  }

  if (ctx.impersonating) {
    return NextResponse.json(
      { error: "Cannot open Stripe portal while impersonating a client." },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const returnUrl: string =
    typeof body.returnUrl === "string" && body.returnUrl.startsWith("https://")
      ? body.returnUrl
      : `${process.env.NEXT_PUBLIC_BASE_URL || "https://app.ironbooks.com"}/portal/billing`;

  const service = createServiceSupabase();
  const { data: clientLink } = await service
    .from("client_links")
    .select("stripe_customer_id")
    .eq("id", ctx.clientLinkId)
    .single();

  const stripeCustomerId = (clientLink as any)?.stripe_customer_id as string | null;
  if (!stripeCustomerId) {
    return NextResponse.json(
      { error: "No Stripe customer linked to this account yet. Email admin@ironbooks.com for help." },
      { status: 422 }
    );
  }

  try {
    const url = await createCustomerPortalSession(stripeCustomerId, returnUrl);
    return NextResponse.json({ url });
  } catch (e: any) {
    console.error("[customer-portal] Stripe error:", e.message);
    return NextResponse.json({ error: "Could not open billing portal. Try again or email admin@ironbooks.com." }, { status: 502 });
  }
}
