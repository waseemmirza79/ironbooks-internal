import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/portal/cleanup-reports
 * Portal read-only access to published cleanup_reports snapshots.
 */
export async function GET() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message }, { status: 401 });
  }

  const service = createServiceSupabase();
  const { data, error } = await service
    .from("cleanup_reports")
    .select("id, run_id, report_data, ai_summary, published_at, created_at, health_score_id")
    .eq("client_link_id", ctxResult.ctx.clientLinkId)
    .eq("published_to_portal", true)
    .order("published_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: healthScores } = await service
    .from("bs_health_scores")
    .select("id, overall_score, overall_grade, computed_at")
    .eq("client_link_id", ctxResult.ctx.clientLinkId)
    .order("computed_at", { ascending: false })
    .limit(5);

  return NextResponse.json({
    reports: data || [],
    health_scores: healthScores || [],
  });
}
