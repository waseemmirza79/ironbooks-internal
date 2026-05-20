import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/approve-review
 *
 * Senior-only: approve a cleanup that's in the In Review stage. Marks
 * the client fully complete (cleanup_completed_at set), records who
 * reviewed and when, and bumps the row into the Completed Accounts
 * partition on /clients. The reviewer is expected to copy the branded
 * email to clipboard (done client-side in the review modal) and paste
 * into Double before clicking Approve.
 *
 * Body (optional):
 *   { notes?: string } — free-text reviewer notes appended to the
 *     audit trail and stored on the client_link for later reference.
 *
 * Role gate: admin or lead only. Juniors who submitted the cleanup
 * can't self-approve.
 *
 * Returns: { ok: true, completed_at: <iso> }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Role check — senior bookkeepers only.
  const { data: profile } = await supabase
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    return NextResponse.json(
      { error: "Only admin/lead bookkeepers can approve cleanup reviews." },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const notes: string | undefined = body?.notes;

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select(
      "id, client_name, cleanup_review_state, cleanup_completed_at, cleanup_review_submitted_by, cleanup_range_start, cleanup_range_end"
    )
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  if ((client as any).cleanup_completed_at) {
    return NextResponse.json({ ok: true, already: "complete" });
  }
  if ((client as any).cleanup_review_state !== "in_review") {
    return NextResponse.json(
      {
        error:
          "Cleanup isn't in the review queue. Have the bookkeeper submit it for review first.",
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const { error: updErr } = await service
    .from("client_links")
    .update({
      cleanup_completed_at: now,
      cleanup_completed_by: user.id,
      cleanup_review_state: "complete",
      cleanup_reviewed_at: now,
      cleanup_reviewed_by: user.id,
      cleanup_review_notes: notes || null,
    } as any)
    .eq("id", clientLinkId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Audit
  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "client_cleanup_review_approved",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        submitted_by: (client as any).cleanup_review_submitted_by,
        reviewed_by_name: (profile as any).full_name,
        notes: notes || null,
        range_start: (client as any).cleanup_range_start,
        range_end: (client as any).cleanup_range_end,
      } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({
    ok: true,
    completed_at: now,
    next: "/clients",
  });
}
