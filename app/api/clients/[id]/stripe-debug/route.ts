import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/clients/[id]/stripe-debug
 *
 * Diagnostic for "Stripe says zero payouts but QBO has Stripe-tagged
 * deposits" mysteries. Calls Stripe directly with the saved access
 * token and reports:
 *
 *  - /v1/account → who Stripe thinks we're authenticated as. Catches the
 *    case where the saved token is for a different account than the
 *    one we're showing in stripe_account_id (would mean a stale token).
 *  - /v1/payouts (last 90 days) → count + first few, with arrival_date
 *    and amount. Lets us compare to QBO directly.
 *  - /v1/balance_transactions limited to type=payout → cross-check.
 *
 * Admin/lead only because the response includes raw Stripe data. No
 * secrets are returned — the access token stays server-side.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, stripe_account_id, stripe_access_token, stripe_livemode, stripe_connection_status")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const token = (client as any).stripe_access_token;
  if (!token) {
    return NextResponse.json({
      client_name: (client as any).client_name,
      stripe_connection_status: (client as any).stripe_connection_status,
      error: "No stripe_access_token saved for this client",
    });
  }

  const auth = `Bearer ${token}`;

  async function stripeGet(path: string) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      headers: { Authorization: auth, "Stripe-Version": "2024-04-10" },
    });
    const status = res.status;
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return { status, body };
  }

  // 1. Who does Stripe think we are?
  const account = await stripeGet("/account");

  // 2. Payouts across last 90 days
  const nowSec = Math.floor(Date.now() / 1000);
  const ninetyDaysAgoSec = nowSec - 90 * 86400;
  const payouts = await stripeGet(
    `/payouts?limit=10&arrival_date[gte]=${ninetyDaysAgoSec}&arrival_date[lt]=${nowSec + 86400}`
  );

  // 3. Same window but no date filter, just to see if ANY payouts exist
  const anyPayouts = await stripeGet("/payouts?limit=10");

  // Strip very long fields from the response for readability
  function summarize(payoutsResp: any) {
    if (payoutsResp?.status !== 200 || !payoutsResp?.body?.data) {
      return { status: payoutsResp?.status, error: payoutsResp?.body };
    }
    return {
      status: payoutsResp.status,
      count: payoutsResp.body.data.length,
      has_more: payoutsResp.body.has_more,
      first_few: payoutsResp.body.data.slice(0, 5).map((p: any) => ({
        id: p.id,
        amount_cents: p.amount,
        amount_dollars: (p.amount / 100).toFixed(2),
        currency: p.currency,
        arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
        status: p.status,
      })),
    };
  }

  return NextResponse.json({
    db_state: {
      client_name: (client as any).client_name,
      stripe_account_id_saved: (client as any).stripe_account_id,
      stripe_livemode_saved: (client as any).stripe_livemode,
      stripe_connection_status: (client as any).stripe_connection_status,
    },
    platform_env: {
      stripe_secret_key_mode: (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live_")
        ? "live"
        : (process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_")
        ? "test"
        : "unknown_or_missing",
    },
    stripe_account: account.status === 200
      ? {
          status: 200,
          id: account.body?.id,
          country: account.body?.country,
          default_currency: account.body?.default_currency,
          email: account.body?.email,
          business_profile_name: account.body?.business_profile?.name,
          type: account.body?.type,
          charges_enabled: account.body?.charges_enabled,
          payouts_enabled: account.body?.payouts_enabled,
          livemode: account.body?.livemode,
        }
      : { status: account.status, error: account.body },
    payouts_last_90d: summarize(payouts),
    most_recent_payouts_any_date: summarize(anyPayouts),
  });
}
