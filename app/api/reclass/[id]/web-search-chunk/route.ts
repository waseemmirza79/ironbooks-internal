import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runWebSearchChunk } from "@/lib/web-search-runner";
import { NextResponse } from "next/server";
import { after } from "next/server";

/**
 * POST /api/reclass/[id]/web-search-chunk
 *
 * Runs web search for ALL unique vendors still needing search, in batches of
 * BATCH_SIZE processed in parallel per batch. Returns immediately; search runs
 * in the background via after(). Progress is written to error_message after
 * each batch so the UI can show "Batch X of Y".
 *
 * After all batches:
 *   - status = 'in_review'
 *   - Or 'in_review' early if skip signal fired mid-run
 *
 * Skip signal: the skip-web-search route sets error_message='[skip_web_search]'.
 * A poller inside this handler checks every 2s and aborts in-flight requests via
 * AbortController, so skip is near-instant (≤2s) rather than waiting for the
 * current batch to finish.
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
    .select("id, status, bookkeeper_id, client_link_id")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status !== "web_search_paused") {
    return NextResponse.json(
      { error: `Job is not paused for web search (status: ${job.status})` },
      { status: 409 }
    );
  }

  // Mark running so the UI shows the spinner again
  await service
    .from("reclass_jobs")
    .update({ status: "executing" } as any)
    .eq("id", id);

  after(async () => {
    try {
      await runWebSearchChunk(id);
    } catch (err: any) {
      console.error(`[web-search-chunk] Failed for job ${id}:`, err);
      const svc = createServiceSupabase();
      // Count prior consecutive failures by parsing the current error_message
      // for `[web_search_error retries=N]`. After 3 failures, give up on
      // web search and hand the job to the bookkeeper as `in_review` so a
      // transient Anthropic outage can't permanently park the job — the
      // decisions made before web search are valid; the low-confidence
      // vendors just show up as needs_review.
      const { data: cur } = await svc
        .from("reclass_jobs")
        .select("error_message")
        .eq("id", id)
        .single();
      const prevMsg: string = (cur as any)?.error_message || "";
      const m = prevMsg.match(/retries=(\d+)/);
      const retries = (m ? parseInt(m[1], 10) : 0) + 1;
      const MAX_RETRIES = 3;

      if (retries >= MAX_RETRIES) {
        await svc
          .from("reclass_jobs")
          .update({
            status: "in_review",
            error_message:
              `Web search failed ${retries}× (${err.message}). Skipped web search — finish review manually; low-confidence vendors show as needs_review.`,
          } as any)
          .eq("id", id);
      } else {
        await svc
          .from("reclass_jobs")
          .update({
            status: "web_search_paused",
            error_message: `[web_search_error retries=${retries}] ${err.message} — click Continue to retry`,
          } as any)
          .eq("id", id);
      }
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}
