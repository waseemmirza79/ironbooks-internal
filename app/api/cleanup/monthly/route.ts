import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { startCleanupRun, checkActiveRun } from "@/lib/cleanup-system/orchestrator";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup/monthly
 * Lighter monthly-close BS check. Body: { client_link_id, period_lock_date }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { client_link_id, period_lock_date } = body;

  if (!client_link_id) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const lockDate =
    period_lock_date ||
    new Date(new Date().getFullYear(), new Date().getMonth(), 0)
      .toISOString()
      .slice(0, 10);

  const service = createServiceSupabase();
  const perm = await requireOwnerOrSenior(service, client_link_id, auth.userId, auth.role);
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  const existing = await checkActiveRun(service, client_link_id);
  if (existing) {
    return NextResponse.json({ run_id: existing.id, resumed: true });
  }

  try {
    const { runId, healthScoreId } = await startCleanupRun(
      service,
      client_link_id,
      auth.userId,
      { periodLockDate: lockDate, workflowMode: "monthly_close" }
    );
    return NextResponse.json({ ok: true, run_id: runId, health_score_id: healthScoreId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
