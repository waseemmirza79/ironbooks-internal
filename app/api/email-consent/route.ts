import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { verifyConsentToken } from "@/lib/bulk-email";

export const dynamic = "force-dynamic";

/**
 * POST /api/email-consent  — PUBLIC (token-authenticated, no login).
 * Body: { token, action: "unsubscribe" | "resubscribe" }
 * Flips a client's marketing consent from the email footer links.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = verifyConsentToken(body.token || "");
  if (!clientLinkId) return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 });
  const action = body.action === "resubscribe" ? "resubscribe" : "unsubscribe";

  const service = createServiceSupabase();
  const subscribe = action === "resubscribe";
  const { error } = await service
    .from("client_links")
    .update({
      marketing_subscribed: subscribe,
      marketing_unsubscribed_at: subscribe ? null : new Date().toISOString(),
      marketing_unsub_source: subscribe ? null : "link",
    } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, subscribed: subscribe });
}
