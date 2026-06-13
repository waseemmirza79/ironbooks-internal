import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/today/item-override
 *
 * Manager controls for a Today-queue item. Items are keyed by a stable
 * item_key the widgets build (e.g. "escalation:<audit_id>"). Admin/lead
 * only. Upserts one row per item_key.
 *
 * Body: { item_key, action: "resolve"|"unresolve"|"hide"|"set_due", due_date? }
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
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — managers only" }, { status: 403 });
  }

  let body: { item_key?: string; action?: string; due_date?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const itemKey = (body.item_key || "").trim().slice(0, 200);
  const action = body.action;
  if (!itemKey || !["resolve", "unresolve", "hide", "set_due"].includes(action || "")) {
    return NextResponse.json({ error: "item_key and a valid action are required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const patch: Record<string, any> = { item_key: itemKey, updated_by: user.id, updated_at: now };
  switch (action) {
    case "resolve":
      patch.resolved_at = now;
      break;
    case "unresolve":
      patch.resolved_at = null;
      break;
    case "hide":
      patch.hidden_at = now;
      break;
    case "set_due":
      patch.due_date = body.due_date && /^\d{4}-\d{2}-\d{2}$/.test(body.due_date) ? body.due_date : null;
      break;
  }

  const { error } = await (service as any)
    .from("today_item_overrides")
    .upsert(patch, { onConflict: "item_key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
