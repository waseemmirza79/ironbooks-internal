import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/cleanup-system/auth";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: run, error } = await service
    .from("cleanup_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (error || !run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: modules } = await service
    .from("cleanup_run_modules")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("*")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: proposedCount } = await service
    .from("proposed_entries")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);

  const { count: pendingReview } = await service
    .from("proposed_entries")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in("decision", ["pending", "needs_review", "flagged"]);

  const { data: cpaFlags } = await service
    .from("cpa_flags")
    .select("id, flag_type, description, status")
    .eq("run_id", runId);

  return NextResponse.json({
    run,
    modules: modules || [],
    health_score: healthScore,
    counts: {
      proposed: proposedCount || 0,
      pending_review: pendingReview || 0,
    },
    cpa_flags: cpaFlags || [],
  });
}
