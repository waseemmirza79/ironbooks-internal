import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/clients/[id]/bs-ai-fix/[runId]/item/[itemId]
 *
 * Update a single item's decision (accepted / modified / rejected).
 *
 * Body:
 *   { decision: "accepted" }
 *   { decision: "rejected" }
 *   { decision: "modified", modified_fix: <ProposedFix> }
 *
 * Returns the updated item.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; runId: string; itemId: string }> }
) {
  const { id: clientLinkId, runId, itemId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Authz — verify the item belongs to the client + run
  const { data: item } = await service
    .from("bs_ai_fix_items" as any)
    .select("id, run_id, client_link_id, decision")
    .eq("id", itemId)
    .single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if ((item as any).client_link_id !== clientLinkId || (item as any).run_id !== runId) {
    return NextResponse.json({ error: "Item does not belong to this run" }, { status: 403 });
  }
  if (["executed", "failed"].includes((item as any).decision)) {
    return NextResponse.json(
      { error: `Item already ${(item as any).decision}; cannot change decision.` },
      { status: 409 }
    );
  }

  const body = await request.json();
  const decision = String(body.decision || "");

  if (!["accepted", "modified", "rejected", "pending"].includes(decision)) {
    return NextResponse.json(
      { error: "decision must be one of accepted | modified | rejected | pending" },
      { status: 400 }
    );
  }

  const update: any = {
    decision,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
  };
  if (decision === "modified") {
    if (!body.modified_fix) {
      return NextResponse.json(
        { error: "modified_fix required when decision=modified" },
        { status: 400 }
      );
    }
    update.modified_fix = body.modified_fix;
  } else if (decision === "pending") {
    update.decided_by = null;
    update.decided_at = null;
  }

  const { error } = await service
    .from("bs_ai_fix_items" as any)
    .update(update)
    .eq("id", itemId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Refresh run-level aggregates
  await refreshRunCounts(service, runId);

  return NextResponse.json({ ok: true, decision });
}

async function refreshRunCounts(
  service: ReturnType<typeof createServiceSupabase>,
  runId: string
) {
  const { data: items } = await service
    .from("bs_ai_fix_items" as any)
    .select("decision")
    .eq("run_id", runId);
  const rows = (items as any[]) || [];
  const accepted = rows.filter((r) => r.decision === "accepted").length;
  const modified = rows.filter((r) => r.decision === "modified").length;
  const rejected = rows.filter((r) => r.decision === "rejected").length;
  await service
    .from("bs_ai_fix_runs" as any)
    .update({
      accepted_count: accepted,
      modified_count: modified,
      rejected_count: rejected,
    } as any)
    .eq("id", runId);
}
