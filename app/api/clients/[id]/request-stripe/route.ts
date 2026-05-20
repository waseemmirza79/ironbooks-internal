import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { generateConnectToken } from "@/lib/stripe-oauth";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/request-stripe
 *
 * Generates a Stripe connect token, stamps stripe_request_sent_at on
 * client_links, and returns the connect URL for the bookkeeper to send.
 * Moves the kanban card to "Awaiting Stripe".
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, stripe_connection_status")
    .eq("id", clientId)
    .single();

  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if (client.stripe_connection_status === "connected") {
    return NextResponse.json({ error: "Stripe already connected" }, { status: 400 });
  }

  const token = generateConnectToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await service.from("stripe_connect_tokens").insert({
    token,
    client_link_id: clientId,
    created_by: user.id,
    expires_at: expiresAt,
  } as any);

  const now = new Date().toISOString();
  await service
    .from("client_links")
    .update({
      stripe_connection_status: "pending",
      stripe_request_sent_at: now,
    } as any)
    .eq("id", clientId);

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "stripe_connect_link_generated",
    request_payload: {
      message: `Stripe connect link generated for ${client.client_name} via kanban`,
      client_link_id: clientId,
      expires_at: expiresAt,
    } as any,
  });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://snap.ironbooks.com";
  const url = `${baseUrl}/stripe-connect/${token}`;

  return NextResponse.json({ url, token, expires_at: expiresAt });
}
