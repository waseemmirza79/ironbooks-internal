import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/users/[id]/clients
 *
 * Admin-only. Returns the active clients currently assigned to this user —
 * used by the "Transfer clients" flow (e.g. before deactivating a bookkeeper).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: targetUserId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { data: clients, error } = await service
    .from("client_links")
    .select("id, client_name, status")
    .eq("assigned_bookkeeper_id", targetUserId)
    .eq("is_active", true)
    .order("client_name", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ clients: clients || [] });
}
