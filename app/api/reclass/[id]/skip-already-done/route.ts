import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/reclass/[id]/skip-already-done
 *
 * "This client already completed reclass for this period — skip Step 2
 * and advance to Step 3 (Bank Rules)." A per-job escape hatch for cleanups
 * inherited from prior bookkeepers, or periods where reclass was done
 * manually in QBO before the client onboarded to SNAP.
 *
 * Marks the job complete WITHOUT executing any reclassifications. Logs
 * to audit_log so we can distinguish "0 reclassifications because nothing
 * needed doing" from "0 reclassifications because bookkeeper skipped".
 *
 * Permission: owner OR admin/lead, same as /cancel.
 *
 * Acceptable starting states: any status except already-complete (skip
 * is a no-op there) and actively-executing (you don't want to skip
 * mid-execution and lose the running QBO writes).
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id, client_link_id, workflow")
    .eq("id", id)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const isSenior = ["admin", "lead"].includes(actor?.role ?? "");
  const isOwner = job.bookkeeper_id === user.id;

  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Already complete → no-op success so the UI can advance regardless
  if (job.status === "complete") {
    return NextResponse.json({ ok: true, alreadyComplete: true });
  }

  // Mid-execution = block. Let the execute pipeline finish (or hit /cancel)
  // before skipping. Skipping mid-execute could orphan QBO writes in flight.
  if (job.status === "executing") {
    return NextResponse.json(
      {
        error:
          "Job is currently executing in QBO. Wait for it to finish or cancel it first, then skip.",
      },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const { error: updErr } = await service
    .from("reclass_jobs")
    .update({
      status: "complete",
      // ai_completed_at gates a bunch of UI — fill it if missing so the
      // workflow stepper doesn't think discovery is still pending.
      ai_completed_at: now,
      execution_started_at: now,
      execution_completed_at: now,
      // Recorded so the history view doesn't read "0 reclassifications"
      // as a silent failure. Bookkeepers reviewing this job later need
      // to understand why nothing ran.
      error_message: `Skipped — bookkeeper marked reclass as already done for this period (was in '${job.status}').`,
    } as any)
    .eq("id", id);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await service.from("audit_log").insert({
    event_type: "reclass_skipped_already_done",
    user_id: user.id,
    request_payload: {
      reclass_job_id: id,
      client_link_id: job.client_link_id,
      workflow: job.workflow,
      prior_status: job.status,
      reason: "already_done",
    } as any,
  });

  return NextResponse.json({ ok: true });
}
