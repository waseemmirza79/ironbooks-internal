import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { runQAGate, saveQAGateResult } from "@/lib/cleanup-system/qa-gate";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup/[runId]/deliver
 * Generates cleanup report, optionally publishes to portal.
 * Body: { publish_to_portal?: boolean, ai_summary?: string, ai_summary_reviewed?: boolean }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const service = createServiceSupabase();

  const { data: run } = await service
    .from("cleanup_runs")
    .select("*, client_link_id")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (run as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  const qa = await runQAGate(service, runId, (run as any).client_link_id);
  await saveQAGateResult(service, runId, qa);
  if (!qa.passed) {
    return NextResponse.json({ error: "QA gate failed", qa }, { status: 422 });
  }

  const { data: modules } = await service
    .from("cleanup_run_modules")
    .select("module, status, executed_count, proposed_count")
    .eq("run_id", runId);

  const { data: executed } = await service
    .from("proposed_entries")
    .select("module, entry_type, amount, memo, executed_at")
    .eq("run_id", runId)
    .eq("executed", true);

  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("*")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const reportData = {
    run_id: runId,
    modules: modules || [],
    executed_entries: executed || [],
    health_score: healthScore,
    delivered_at: new Date().toISOString(),
    delivered_by: auth.userId,
  };

  const { data: report, error } = await service
    .from("cleanup_reports")
    .insert({
      client_link_id: (run as any).client_link_id,
      run_id: runId,
      health_score_id: (run as any).health_score_id,
      report_data: reportData,
      ai_summary: body.ai_summary || null,
      ai_summary_reviewed: !!body.ai_summary_reviewed,
      ai_summary_reviewed_by: body.ai_summary_reviewed ? auth.userId : null,
      published_to_portal: !!body.publish_to_portal,
      published_at: body.publish_to_portal ? new Date().toISOString() : null,
      created_by: auth.userId,
    } as any)
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await service
    .from("cleanup_runs")
    .update({ status: "complete", completed_at: new Date().toISOString() } as any)
    .eq("id", runId);

  return NextResponse.json({ ok: true, report_id: report.id, qa });
}
