import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/grain/unlink  — body { recording_id }
 *
 * Unlink a Grain call from this client when it was matched in error (e.g. a
 * group/cohort call that doesn't really belong here). Deletes the match AND
 * records an exclusion so the next backfill won't re-attach it.
 *
 * Allowed for internal roles (admin/lead/bookkeeper/viewer) OR a portal
 * client who is mapped to this client_link — either side can clean up a
 * wrongly-attributed call.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";

  // Authorize: internal roles outright; a client only for their own link.
  let allowed = ["admin", "lead", "bookkeeper", "viewer"].includes(role);
  if (!allowed && role === "client") {
    const { data: mapping } = await (service as any)
      .from("client_users")
      .select("client_link_id")
      .eq("user_id", user.id)
      .eq("client_link_id", id)
      .eq("active", true)
      .maybeSingle();
    allowed = !!mapping;
  }
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const recordingId = body.recording_id as string;
  if (!recordingId) {
    return NextResponse.json({ error: "recording_id required" }, { status: 400 });
  }

  // Remove the match.
  const { error: delErr } = await service
    .from("grain_recording_matches")
    .delete()
    .eq("recording_id", recordingId)
    .eq("client_link_id", id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  // Record the exclusion so auto-matching won't re-attach it. Tolerate the
  // table being absent (migration 78 not yet applied) — the delete above
  // already takes effect immediately.
  try {
    await (service as any)
      .from("grain_match_exclusions")
      .upsert(
        { recording_id: recordingId, client_link_id: id, excluded_by: user.id },
        { onConflict: "recording_id,client_link_id" }
      );
  } catch {
    /* migration 78 not applied yet — unlink still works for now */
  }

  return NextResponse.json({ ok: true });
}
