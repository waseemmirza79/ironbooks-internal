import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * PATCH /api/today/transaction-flags/[id]
 *
 * Bookkeeper-side action on a portal flag. Marks acknowledged / applied /
 * declined / dismissed with an optional resolution note (visible back to
 * the client).
 *
 * Body:
 *   {
 *     status: "in_review" | "applied" | "declined" | "dismissed",
 *     resolution_note?: string,
 *     resolution_reclass_job_id?: string,  // optional pointer if a reclass was created
 *   }
 *
 * Owner bookkeeper + admin/lead only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: flagId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!["admin", "lead", "bookkeeper"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: flag } = await service
    .from("portal_transaction_flags" as any)
    .select("id, client_link_id, status, account_label")
    .eq("id", flagId)
    .single();
  if (!flag) return NextResponse.json({ error: "Flag not found" }, { status: 404 });

  // Bookkeepers only act on flags for clients they own; seniors see all.
  if (role === "bookkeeper") {
    const { data: client } = await service
      .from("client_links")
      .select("assigned_bookkeeper_id")
      .eq("id", (flag as any).client_link_id)
      .single();
    if ((client as any)?.assigned_bookkeeper_id !== user.id) {
      return NextResponse.json({ error: "Not your client" }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({} as any));
  const ALLOWED = new Set(["in_review", "applied", "declined", "dismissed"]);
  if (!ALLOWED.has(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const isTerminal = body.status !== "in_review";
  const update: any = {
    status: body.status,
    reviewed_by: user.id,
    reviewed_at: isTerminal ? new Date().toISOString() : null,
    resolution_note: body.resolution_note?.toString().slice(0, 1500) || null,
    resolution_reclass_job_id: body.resolution_reclass_job_id || null,
  };

  const { error: updErr } = await service
    .from("portal_transaction_flags" as any)
    .update(update)
    .eq("id", flagId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await service.from("audit_log").insert({
    event_type: `portal_flag_${body.status}`,
    user_id: user.id,
    request_payload: {
      flag_id: flagId,
      client_link_id: (flag as any).client_link_id,
      account_label: (flag as any).account_label,
      resolution_note: body.resolution_note || null,
    } as any,
  });

  return NextResponse.json({ ok: true });
}
