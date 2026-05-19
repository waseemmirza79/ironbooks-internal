import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/stripe-invite-dismiss
 *
 * Mark a detector-flagged client as "don't suggest sending a Stripe
 * invite anymore." Sets stripe_invite_dismissed_at so the dashboard
 * widget skips them on subsequent renders + the detector skips them
 * on subsequent scans.
 *
 * Use cases:
 *  - Client already has the link, just hasn't clicked yet (bookkeeper
 *    is tracking via Stripe Connect Modal already).
 *  - Client doesn't use Stripe in a meaningful way and the QBO
 *    deposits matching our "stripe" regex are actually something else.
 *  - Client declined; we don't want to keep nagging.
 *
 * DELETE clears the dismissal so we re-detect them on the next scan
 * (useful if circumstances change).
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { error } = await service
    .from("client_links")
    .update({
      stripe_invite_dismissed_at: new Date().toISOString(),
    } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit trail so we know who dismissed and when.
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "stripe_invite_dismissed",
      request_payload: { client_link_id: clientLinkId } as any,
    });
  } catch {
    // audit_log column shape varies across envs; non-fatal
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { error } = await service
    .from("client_links")
    .update({
      stripe_invite_dismissed_at: null,
    } as any)
    .eq("id", clientLinkId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
