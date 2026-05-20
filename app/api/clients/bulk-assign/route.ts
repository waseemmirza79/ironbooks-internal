import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/bulk-assign
 *
 * Reassigns all clients from one bookkeeper to another.
 * Admin/lead only.
 *
 * Body: { from_bookkeeper_id: string, to_bookkeeper_id: string }
 *
 * Returns: { updated: number }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!["admin", "lead"].includes(actor?.role ?? "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { from_bookkeeper_id, to_bookkeeper_id } = body;

  if (!from_bookkeeper_id) {
    return NextResponse.json({ error: "from_bookkeeper_id required" }, { status: 400 });
  }

  const { data: updated, error } = await service
    .from("client_links")
    .update({ assigned_bookkeeper_id: to_bookkeeper_id ?? null } as any)
    .eq("assigned_bookkeeper_id", from_bookkeeper_id)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "bulk_reassign",
    request_payload: {
      from_bookkeeper_id,
      to_bookkeeper_id: to_bookkeeper_id ?? null,
      count: updated?.length ?? 0,
    } as any,
  });

  return NextResponse.json({ updated: updated?.length ?? 0 });
}
