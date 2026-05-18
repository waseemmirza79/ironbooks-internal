import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/jobs/[id]/status
 *
 * Returns current job status + audit log entries since the last poll.
 * Used by the live execution page to show real-time progress.
 *
 * Query params:
 *   - since: ISO timestamp - only return events after this time
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const { searchParams } = new URL(request.url);
  const since = searchParams.get("since");

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get current job state
  const { data: job } = await supabase
    .from("coa_jobs")
    .select("status, execution_started_at, execution_completed_at, execution_duration_seconds, error_message, accounts_to_rename, accounts_to_create, accounts_to_delete, accounts_flagged, manual_cleanup_items, merge_candidates")
    .eq("id", jobId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Get recent audit log entries
  let query = supabase
    .from("audit_log")
    .select("event_type, request_payload, response_payload, occurred_at, action_id")
    .eq("job_id", jobId)
    .order("occurred_at", { ascending: true })
    .limit(200);

  if (since) {
    query = query.gt("occurred_at", since);
  }

  const { data: logs } = await query;

  // Auto-recover from silent timeouts. If the job is still 'executing' but
  // we haven't seen ANY audit log event in 5+ minutes, the background
  // function almost certainly died (Vercel killed it past maxDuration,
  // OOM, etc.). Flip the job back to in_review so the bookkeeper can
  // re-execute — the executor is idempotent and will resume where it
  // stopped. Without this the job sits "executing" forever.
  //
  // 5 minutes is a deliberately wide window: a single merge with ~400-500
  // lines can take ~2 minutes of unlogged QBO calls in a row. The executor
  // now emits a heartbeat every 50 lines inside merges, so legitimate
  // long-running work touches the audit log well within this window.
  if (job.status === "executing") {
    const { data: lastEvent } = await supabase
      .from("audit_log")
      .select("occurred_at")
      .eq("job_id", jobId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastTs = lastEvent?.occurred_at ? new Date(lastEvent.occurred_at).getTime() : 0;
    const silenceMs = Date.now() - lastTs;
    if (lastTs > 0 && silenceMs > 300_000) {
      await supabase
        .from("coa_jobs")
        .update({
          status: "in_review",
          execution_started_at: null,
          error_message:
            `Execution timed out at ${new Date(lastTs).toISOString()} ` +
            `(no progress for ${Math.round(silenceMs / 1000)}s). ` +
            `Click Execute again to resume — completed actions are skipped automatically.`,
        } as any)
        .eq("id", jobId);
      job.status = "in_review";
    }
  }

  // Calculate progress.
  // IMPORTANT: denominator must be ONLY actionable items (create/rename/delete).
  // `keep` actions are no-ops and never get executed=true, so including them
  // would make the progress bar permanently stuck below 100%.
  // `flag` actions are also excluded — they're intentionally not executed.
  const { data: actionStats } = await supabase
    .from("coa_actions")
    .select("executed, action, error_message")
    .eq("job_id", jobId);

  const actionable = (actionStats || []).filter(
    (a) => a.action === "create" || a.action === "rename" || a.action === "delete"
  );
  const totalActions = actionable.length;
  const completedActions = actionable.filter((a) => a.executed).length;
  const failedActions = actionable.filter((a) => !a.executed && a.error_message).length;
  const skippedActions = (actionStats || []).filter((a) => a.action === "flag").length;
  const keepActions = (actionStats || []).filter((a) => a.action === "keep").length;
  const progressPct = totalActions > 0 ? Math.round((completedActions / totalActions) * 100) : 0;

  return NextResponse.json({
    status: job.status,
    execution_started_at: job.execution_started_at,
    execution_completed_at: job.execution_completed_at,
    duration_seconds: job.execution_duration_seconds,
    error_message: job.error_message,
    manual_cleanup_items: (job as any).manual_cleanup_items || [],
    merge_candidates: (job as any).merge_candidates || [],
    progress: {
      total: totalActions,
      completed: completedActions,
      failed: failedActions,
      flagged: skippedActions,
      keep: keepActions,
      grand_total: (actionStats || []).length,
      percentage: progressPct,
    },
    stats: {
      to_rename: job.accounts_to_rename,
      to_create: job.accounts_to_create,
      to_delete: job.accounts_to_delete,
      flagged: job.accounts_flagged,
    },
    events: logs || [],
  });
}
