import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * Manual-cleanup stage flag for a client.
 *
 * PATCH → set / clear the "Manual cleanup needed in QuickBooks" flag and its
 *         free-text notes. Body:
 *           { needed?: boolean;   // place in / remove from the stage
 *             notes?: string }    // what to fix by hand (kept as history)
 *
 * The auto-generated detail lives in coa_jobs.manual_cleanup_items (written by
 * the executor); this flag + notes are the bookkeeper-facing layer. Setting
 * needed=true clears any prior resolved_at; needed=false stamps resolved_at but
 * keeps the notes for the record.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const needed: boolean | undefined =
    typeof body?.needed === "boolean" ? body.needed : undefined;
  const notes: string | undefined =
    typeof body?.notes === "string" ? body.notes : undefined;

  if (needed === undefined && notes === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const now = new Date().toISOString();
  const patch: Record<string, any> = {};
  if (notes !== undefined) patch.manual_cleanup_notes = notes || null;
  if (needed !== undefined) {
    patch.manual_cleanup_needed = needed;
    if (needed) {
      patch.manual_cleanup_set_at = now;
      patch.manual_cleanup_set_by = user.id;
      patch.manual_cleanup_resolved_at = null;
    } else {
      patch.manual_cleanup_resolved_at = now;
    }
  }

  const { error: updErr } = await service
    .from("client_links")
    .update(patch as any)
    .eq("id", clientLinkId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type:
        needed === false ? "client_manual_cleanup_resolved" : "client_manual_cleanup_flagged",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        needed,
        has_notes: !!notes,
      } as any,
    });
  } catch {
    /* audit shape varies across envs — non-fatal */
  }

  return NextResponse.json({ ok: true, manual_cleanup_needed: needed ?? undefined });
}
