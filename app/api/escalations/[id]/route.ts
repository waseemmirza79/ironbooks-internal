import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/escalations/[id]
 *   { action: "resolve", resolution_note?: string }
 *   { action: "reopen" }
 *   { action: "assign", assignee_id: string | null }
 *
 * One-click resolve by design — friction here is how escalations rot.
 * Any staff member may resolve (the raiser, the assignee, or a senior
 * closing it out); the resolver is recorded.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { action?: string; resolution_note?: string; assignee_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let update: Record<string, unknown>;
  if (body.action === "resolve") {
    update = {
      status: "resolved",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: (body.resolution_note || "").trim().slice(0, 2000) || null,
    };
  } else if (body.action === "reopen") {
    update = { status: "open", resolved_by: null, resolved_at: null, resolution_note: null };
  } else if (body.action === "assign") {
    update = { assignee_id: body.assignee_id || null };
  } else {
    return NextResponse.json({ error: "action must be resolve, reopen, or assign" }, { status: 400 });
  }

  const { data: row, error } = await (service as any)
    .from("client_escalations")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Escalation not found" }, { status: 404 });

  return NextResponse.json({ ok: true, escalation: row });
}
