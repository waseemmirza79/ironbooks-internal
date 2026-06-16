import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { resolvePortalContext } from "@/lib/portal-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/billing/cancel-request
 *
 * Logs a client's cancel request (does NOT cancel the account). Sets
 * billing_cancel_request_at + billing_cancel_request_note on client_links,
 * then sends an email notification to admin@ironbooks.com.
 *
 * Idempotent: re-submitting updates the note and refreshes the timestamp.
 * Impersonating admins are blocked — cancel requests must come from the client.
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
      { error: "Cancel requests must be submitted by the client, not an admin." },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const note: string | null = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const service = createServiceSupabase();
  const now = new Date().toISOString();

  const { error } = await service
    .from("client_links")
    .update({
      billing_cancel_request_at: now,
      billing_cancel_request_note: note,
    } as any)
    .eq("id", ctx.clientLinkId);

  if (error) {
    console.error("[cancel-request] DB update failed:", error.message);
    return NextResponse.json({ error: "Failed to save request" }, { status: 500 });
  }

  // Log to audit trail
  await service.from("audit_log").insert({
    event_type: "billing_cancel_requested",
    user_id: ctx.userId,
    client_link_id: ctx.clientLinkId,
    metadata: { note, submitted_at: now },
  } as any);

  // Email notification — uses mailto pattern; in production wire to
  // Resend/SendGrid via an env var. Falls back gracefully if not configured.
  try {
    const notifyUrl = process.env.INTERNAL_NOTIFY_URL;
    if (notifyUrl) {
      await fetch(notifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: "admin@ironbooks.com",
          subject: `Cancel request — ${ctx.clientName}`,
          text: [
            `${ctx.clientName} submitted a cancellation request via the Ironbooks portal.`,
            ``,
            `Client: ${ctx.clientName}`,
            `Client link ID: ${ctx.clientLinkId}`,
            `Submitted: ${new Date(now).toLocaleString("en-US")}`,
            note ? `\nNote from client:\n"${note}"` : "",
            ``,
            `This does NOT cancel the account. Follow up within 1–2 business days.`,
          ].join("\n"),
        }),
      });
    }
  } catch (notifyErr: any) {
    // Non-fatal — the DB record is the source of truth
    console.warn("[cancel-request] Notify failed:", notifyErr.message);
  }

  return NextResponse.json({ ok: true, submitted_at: now });
}
