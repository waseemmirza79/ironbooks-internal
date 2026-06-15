import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { runAiChunks } from "@/app/api/reclass/discover/route";

/**
 * POST /api/reclass/[id]/categorize-chunk
 *
 * "Continue" gate for the chunked full-categorization path. Discovery on a large
 * job persists the decided rows, enqueues every line still needing Claude into
 * reclass_ai_queue, and parks the job at status='ai_paused'. Each call here runs
 * runAiChunks() in a fresh invocation (own 800s budget): it drains the queue in
 * time-bounded chunks, writing real reclassifications rows as it goes, then
 * either finalizes (→ web_search_paused / in_review) or pauses again at
 * 'ai_paused' for the next approved run. No invocation can time out
 * mid-categorization, and progress is never lost.
 *
 * Mirrors web-search-chunk: requires status='ai_paused', flips to executing,
 * runs in the background via after(), and on a thrown error parks back at
 * ai_paused with a retry counter (gives up to in_review after MAX_RETRIES so a
 * transient outage can't permanently block the job — partial decisions stand).
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if ((job.status as string) !== "ai_paused") {
    return NextResponse.json(
      { error: `Job is not paused for categorization (status: ${job.status})` },
      { status: 409 }
    );
  }

  after(async () => {
    try {
      await runAiChunks(id);
    } catch (err: any) {
      console.error(`[categorize-chunk] Failed for job ${id}:`, err);
      const svc = createServiceSupabase();
      // Count prior consecutive failures from `[ai_error retries=N]` in
      // error_message. After MAX_RETRIES, hand the job to the bookkeeper as
      // in_review so a transient Anthropic / QBO outage can't permanently park
      // it — rows already categorized are valid; the rest just won't be done.
      const { data: cur } = await svc
        .from("reclass_jobs")
        .select("error_message")
        .eq("id", id)
        .single();
      const prevMsg: string = (cur as any)?.error_message || "";
      const m = prevMsg.match(/\[ai_error retries=(\d+)/);
      const retries = (m ? parseInt(m[1], 10) : 0) + 1;
      const MAX_RETRIES = 3;

      if (retries >= MAX_RETRIES) {
        await svc
          .from("reclass_jobs")
          .update({
            status: "in_review",
            ai_completed_at: new Date().toISOString(),
            error_message:
              `Categorization failed ${retries}× (${err.message}). Stopped — review what was categorized; any remaining lines stay uncategorized.`,
          } as any)
          .eq("id", id);
      } else {
        // Re-park at ai_paused, keeping a valid "[ai_progress] done/N" prefix so
        // /status + runAiChunks still read correct progress (done derived from
        // the durable queue depth), with an [ai_error retries=k] suffix the
        // retry counter reads. The [ai_progress] prefix also keeps the raw
        // marker out of the user-facing error text (/status strips it).
        const nMatch = prevMsg.match(/\[ai_progress\]\s*\d+\/(\d+)/);
        const total = nMatch ? parseInt(nMatch[1], 10) : 0;
        const { count } = await svc
          .from("reclass_ai_queue" as any)
          .select("id", { count: "exact", head: true })
          .eq("reclass_job_id", id);
        const done = Math.max(0, total - (count || 0));
        await svc
          .from("reclass_jobs")
          .update({
            status: "ai_paused",
            error_message: `[ai_progress] ${done}/${total} [ai_error retries=${retries}] ${err.message}`,
          } as any)
          .eq("id", id);
      }
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}

export const maxDuration = 800;
