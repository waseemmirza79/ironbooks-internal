import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { startCleanupRun, checkActiveRun } from "@/lib/cleanup-system/orchestrator";
import { qboErrorResponse } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/cleanup/start
 * Body: { client_link_id, period_lock_date, workflow_mode?, as_of_date? }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { client_link_id, period_lock_date, workflow_mode, as_of_date } = body;

  if (!client_link_id || !period_lock_date) {
    return NextResponse.json(
      { error: "client_link_id and period_lock_date are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const perm = await requireOwnerOrSenior(service, client_link_id, auth.userId, auth.role);
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  const existing = await checkActiveRun(service, client_link_id);
  if (existing) {
    return NextResponse.json(
      { error: "Active cleanup run exists", run_id: existing.id, status: existing.status },
      { status: 409 }
    );
  }

  try {
    const { runId, healthScoreId } = await startCleanupRun(
      service,
      client_link_id,
      auth.userId,
      { periodLockDate: period_lock_date, workflowMode: workflow_mode, asOfDate: as_of_date }
    );
    return NextResponse.json({ ok: true, run_id: runId, health_score_id: healthScoreId });
  } catch (err: unknown) {
    const qboRes = qboErrorResponse(err);
    if (qboRes.status !== 500) return qboRes;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/cleanup/start?client_link_id=...
 * Returns active run if any.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clientLinkId = new URL(request.url).searchParams.get("client_link_id");
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const active = await checkActiveRun(service, clientLinkId);

  const { data: latest } = await service
    .from("cleanup_runs")
    .select("id, status, health_score_id, current_module, qa_passed_at, workflow_mode, created_at")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ active_run: active, latest_run: latest });
}
