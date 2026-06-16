import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/users/[id]/transfer-clients
 *
 * Admin-only. Reassigns some/all of [id]'s active clients to other staff, and
 * optionally deactivates [id] afterward. Built for the "deactivate a bookkeeper
 * → hand off their book" flow, but also usable to redistribute a caseload
 * without deactivating.
 *
 * Body: {
 *   assignments: [{ client_link_id, to_bookkeeper_id }],  // one target per client
 *   deactivate?: boolean                                   // also disable [id]
 * }
 *
 * Each client can go to a different target ("one or more" bookkeepers/managers).
 * Updates are scoped to clients actually assigned to [id], so a stale client id
 * can't reassign someone else's client. Writes one audit_log entry.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: sourceUserId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if ((actor as any)?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const assignments: Array<{ client_link_id: string; to_bookkeeper_id: string }> =
    Array.isArray(body.assignments) ? body.assignments : [];
  const deactivate: boolean = !!body.deactivate;

  if (assignments.length === 0 && !deactivate) {
    return NextResponse.json({ error: "Nothing to do — no assignments and no deactivate." }, { status: 400 });
  }

  // Validate every target is active staff (bookkeeper / lead / admin).
  const targetIds = [...new Set(assignments.map((a) => a.to_bookkeeper_id).filter(Boolean))];
  if (targetIds.length > 0) {
    const { data: targets } = await service
      .from("users")
      .select("id, role, is_active")
      .in("id", targetIds);
    const valid = new Set(
      ((targets || []) as any[])
        .filter((t) => t.is_active !== false && ["admin", "lead", "bookkeeper"].includes(t.role))
        .map((t) => t.id)
    );
    const bad = targetIds.filter((t) => !valid.has(t));
    if (bad.length > 0) {
      return NextResponse.json(
        { error: "One or more targets are not active bookkeepers/managers." },
        { status: 400 }
      );
    }
    if (targetIds.includes(sourceUserId)) {
      return NextResponse.json(
        { error: "Can't reassign clients back to the bookkeeper being transferred." },
        { status: 400 }
      );
    }
  }

  // Group by target so each target is one scoped UPDATE. Scope to clients
  // actually owned by the source user so a stale id can't move someone else's.
  const byTarget = new Map<string, string[]>();
  for (const a of assignments) {
    if (!a.client_link_id || !a.to_bookkeeper_id) continue;
    if (!byTarget.has(a.to_bookkeeper_id)) byTarget.set(a.to_bookkeeper_id, []);
    byTarget.get(a.to_bookkeeper_id)!.push(a.client_link_id);
  }

  let transferred = 0;
  for (const [toId, clientIds] of byTarget) {
    const { data, error } = await service
      .from("client_links")
      .update({ assigned_bookkeeper_id: toId } as any)
      .in("id", clientIds)
      .eq("assigned_bookkeeper_id", sourceUserId)
      .eq("is_active", true)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    transferred += (data || []).length;
  }

  let deactivated = false;
  if (deactivate) {
    if (sourceUserId === user.id) {
      return NextResponse.json(
        { error: "Transferred clients, but you can't deactivate your own account.", transferred },
        { status: 400 }
      );
    }
    const { error: deErr } = await service
      .from("users")
      .update({ is_active: false } as any)
      .eq("id", sourceUserId);
    if (deErr) return NextResponse.json({ error: deErr.message, transferred }, { status: 500 });
    deactivated = true;
  }

  await service.from("audit_log").insert({
    user_id: user.id,
    event_type: "bookkeeper_clients_transferred",
    request_payload: {
      admin_name: (actor as any)?.full_name || user.email,
      from_bookkeeper_id: sourceUserId,
      transferred,
      deactivated,
      assignments: assignments.map((a) => ({ client_link_id: a.client_link_id, to_bookkeeper_id: a.to_bookkeeper_id })),
    } as any,
  });

  return NextResponse.json({ transferred, deactivated });
}
