import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { deauthorizeStripeAccount } from "@/lib/stripe-oauth";

/**
 * POST /api/stripe-connect/disconnect
 *
 * Bookkeeper-initiated: revokes Ironbooks' access to a client's Stripe account.
 * Use cases:
 *  - Client requested disconnection
 *  - Wrong client got connected by mistake
 *  - Resetting before re-linking
 *
 * Flow:
 *  1. Call Stripe's /oauth/deauthorize to invalidate the access token
 *  2. Clear the saved tokens + account ID from client_links
 *  3. Set stripe_connection_status back to 'not_set'
 *  4. Audit log it
 *
 * Body: { client_link_id: string }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { client_link_id } = body;
  if (!client_link_id) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Load the client to get the Stripe account ID
  const { data: clientLink } = await service
    .from("client_links")
    .select("id, client_name, stripe_account_id, stripe_connection_status")
    .eq("id", client_link_id)
    .single();

  if (!clientLink) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  if (!clientLink.stripe_account_id) {
    // Nothing to revoke on Stripe's side — but still clear any stale state
    await service
      .from("client_links")
      .update({
        stripe_account_id: null,
        stripe_access_token: null,
        stripe_refresh_token: null,
        stripe_connected_at: null,
        stripe_connection_status: "not_set",
      } as any)
      .eq("id", client_link_id);

    return NextResponse.json({
      ok: true,
      message: "No active Stripe connection to revoke. State cleared.",
    });
  }

  // Revoke on Stripe's side first — if this fails, don't clear our state
  // so the bookkeeper can retry. (deauthorizeStripeAccount treats
  // application_not_authorized as success.)
  try {
    await deauthorizeStripeAccount(clientLink.stripe_account_id);
  } catch (err: any) {
    console.error("[stripe-connect/disconnect] Deauthorize failed:", err.message);
    return NextResponse.json(
      { error: `Could not revoke on Stripe: ${err.message}` },
      { status: 502 }
    );
  }

  // Clear our stored connection
  const { error: updErr } = await service
    .from("client_links")
    .update({
      stripe_account_id: null,
      stripe_access_token: null,
      stripe_refresh_token: null,
      stripe_connected_at: null,
      stripe_connection_status: "not_set",
    } as any)
    .eq("id", client_link_id);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Audit log
  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "stripe_oauth_disconnected",
    request_payload: {
      message: `Stripe disconnected for ${clientLink.client_name}`,
      client_link_id,
      stripe_account_id: clientLink.stripe_account_id,
    } as any,
  } as any);

  return NextResponse.json({
    ok: true,
    message: `Stripe disconnected for ${clientLink.client_name}.`,
  });
}
