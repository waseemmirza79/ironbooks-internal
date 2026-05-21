import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/reclass/[id]/status
 *
 * Live polling endpoint. Returns job state + recent audit events.
 * Query param: since (ISO timestamp) returns only events after.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const { searchParams } = new URL(request.url);
  const since = searchParams.get("since");

  // Outer try/catch so any thrown error becomes a structured 500 instead of a
  // silent failure that the UI just labels "Status check failed". Caught
  // errors include the message + (in dev) the stack so we can diagnose what
  // actually broke in the polling loop.
  try {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Session expired — reload the page and sign in again." }, { status: 401 });

  const { data: job, error: jobErr } = await supabase
    .from("reclass_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (jobErr) {
    return NextResponse.json(
      { error: `Job lookup failed: ${jobErr.message}` },
      { status: 500 }
    );
  }
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let logsQuery = supabase
    .from("audit_log")
    .select("event_type, request_payload, response_payload, occurred_at")
    .in("event_type", [
      "reclass_job_start",
      "reclass_progress",
      "reclass_job_complete",
      "reclass_job_failed",
    ])
    .order("occurred_at", { ascending: true })
    .limit(200);

  // Filter by this job's ID using JSONB containment
  logsQuery = logsQuery.filter(
    "request_payload->>reclass_job_id",
    "eq",
    jobId
  );

  if (since) logsQuery = logsQuery.gt("occurred_at", since);

  const { data: events } = await logsQuery;

  // Count executed rows
  const { count: executed } = await supabase
    .from("reclassifications")
    .select("*", { count: "exact", head: true })
    .eq("reclass_job_id", jobId)
    .eq("status", "executed");

  // Total approved (target denominator for progress)
  const { count: totalApproved } = await supabase
    .from("reclassifications")
    .select("*", { count: "exact", head: true })
    .eq("reclass_job_id", jobId)
    .in("decision", ["auto_approve", "approved"]);

  const total = totalApproved || 0;
  const completed = executed || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Parse AI batch progress. Format: "[ai_progress] done/total"
  let aiProgress: { done: number; total: number } | null = null;
  const aiMatch = (job.error_message || "").match(/\[ai_progress\]\s*(\d+)\/(\d+)/);
  if (aiMatch) {
    aiProgress = { done: parseInt(aiMatch[1], 10), total: parseInt(aiMatch[2], 10) };
  }

  // Parse the current phase marker. Format: "[phase] label_text"
  // Phases: pulling_transactions, fetching_accounts, pre_matching,
  // running_ai (N lines), saving (N rows). Surfaces what the worker is
  // doing during the long pre-AI / post-AI windows when ai_progress is null.
  let phase: string | null = null;
  const phaseMatch = (job.error_message || "").match(/^\[phase\]\s+(.+)$/);
  if (phaseMatch) phase = phaseMatch[1].trim();

  // Parse web search progress from error_message. Format: "[web_search_progress] done/total"
  let webSearchProgress: { done: number; total: number } | null = null;
  const wsMatch = (job.error_message || "").match(/\[web_search_progress\]\s*(\d+)\/(\d+)/);
  if (wsMatch) {
    webSearchProgress = { done: parseInt(wsMatch[1], 10), total: parseInt(wsMatch[2], 10) };
  }

  // Parse pending-web-search count. Format: "[ws_pending] N"
  // Set after AI finishes; UI shows the "Web search N vendors or skip?" prompt.
  let webSearchPendingCount: number | null = null;
  const wsPendingMatch = (job.error_message || "").match(/^\[ws_pending\]\s*(\d+)/);
  if (wsPendingMatch) webSearchPendingCount = parseInt(wsPendingMatch[1], 10);

  // Only pass error_message to the UI for lines the UI should display.
  // Internal state tokens ([ai_progress], [web_search_progress], [skip_ai],
  // [skip_web_search]) are stripped — they're bookkeeping, not user messages.
  const internalPrefixes = ["[ai_progress]", "[web_search_progress]", "[ws_pending]", "[skip_ai]", "[skip_web_search]", "[phase]"];
  const uiErrorMessage = internalPrefixes.some((p) => (job.error_message || "").startsWith(p))
    ? null
    : job.error_message;

  return NextResponse.json({
    status: job.status,
    workflow: job.workflow,
    execution_started_at: job.execution_started_at,
    execution_completed_at: job.execution_completed_at,
    duration_seconds: job.execution_duration_seconds,
    error_message: uiErrorMessage,
    ai_progress: aiProgress,
    phase,
    web_search_progress: webSearchProgress,
    web_search_pending_count: webSearchPendingCount,
    progress: {
      total,
      completed,
      percentage: pct,
    },
    stats: {
      pulled: job.transactions_pulled,
      in_scope: job.transactions_in_scope,
      auto_approve: job.transactions_auto_approve,
      needs_review: job.transactions_needs_review,
      flagged: job.transactions_flagged,
      skipped_reconciled: job.transactions_skipped_reconciled,
      skipped_closed: job.transactions_skipped_closed,
      moved: job.transactions_moved,
      failed: job.transactions_failed,
    },
    events: events || [],
  });
  } catch (err: any) {
    console.error(`[status ${jobId}] FATAL:`, err?.stack || err);
    return NextResponse.json(
      {
        error: `Status endpoint threw: ${err?.message || String(err)}`,
        stack_first_frame: err?.stack?.split("\n")[1]?.trim() || null,
      },
      { status: 500 }
    );
  }
}
