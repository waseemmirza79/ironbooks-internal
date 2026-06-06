import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/cleanup-system/auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const module = searchParams.get("module");
  const decision = searchParams.get("decision");

  const service = createServiceSupabase();
  let query = service.from("proposed_entries").select("*").eq("run_id", runId);
  if (module) query = query.eq("module", module as any);
  if (decision) query = query.eq("decision", decision as any);

  const { data, error } = await query.order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ entries: data || [] });
}

/**
 * PATCH bulk approve auto_approve entries
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { action, module } = body;

  const service = createServiceSupabase();

  if (action === "approve_all_auto") {
    let query = service
      .from("proposed_entries")
      .update({ decision: "approved", updated_at: new Date().toISOString() } as any)
      .eq("run_id", runId)
      .eq("decision", "auto_approve");
    if (module) query = query.eq("module", module as any);
    const { error, count } = await query.select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, approved: (count as any) || 0 });
  }

  if (action === "approve_uf_confident") {
    const { data: rows } = await service
      .from("proposed_entries")
      .select("id, ai_reasoning")
      .eq("run_id", runId)
      .eq("module", "undeposited_funds")
      .in("decision", ["auto_approve", "needs_review"]);
    const confidentIds = (rows || [])
      .filter((r: any) => {
        try {
          const m = JSON.parse(r.ai_reasoning || "{}");
          return m.kind === "exact_invoice_number" || m.kind === "high_confidence";
        } catch {
          return false;
        }
      })
      .map((r: any) => r.id);
    if (confidentIds.length === 0) {
      return NextResponse.json({ ok: true, approved: 0 });
    }
    const { error } = await service
      .from("proposed_entries")
      .update({ decision: "approved", updated_at: new Date().toISOString() } as any)
      .in("id", confidentIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, approved: confidentIds.length });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
