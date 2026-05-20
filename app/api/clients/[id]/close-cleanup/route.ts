import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/close-cleanup
 *
 * Marks onboarding cleanup as complete and moves the client to the MoM
 * kanban. Sets cleanup_completed_at, cleanup_completed_by.
 *
 * Body: { note?: string }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const note: string | undefined = body.note;

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, cleanup_completed_at")
    .eq("id", clientId)
    .single();

  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (client.cleanup_completed_at) {
    return NextResponse.json({ error: "Cleanup already marked complete" }, { status: 400 });
  }

  const now = new Date().toISOString();
  await service
    .from("client_links")
    .update({
      cleanup_completed_at: now,
      cleanup_completed_by: user.id,
      ...(note ? { cleanup_completion_note: note } : {}),
    } as any)
    .eq("id", clientId);

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "cleanup_completed",
    request_payload: {
      message: `Onboarding cleanup closed for ${client.client_name}`,
      client_link_id: clientId,
      note: note || null,
    } as any,
  });

  return NextResponse.json({ ok: true });
}
