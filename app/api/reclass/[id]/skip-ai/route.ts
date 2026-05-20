import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/reclass/[id]/skip-ai
 *
 * Signals the running AI categorization step to stop after the current batch.
 * Sets error_message = '[skip_ai]', which the 2s poller inside runFullCategorization
 * detects and uses to abort the current HTTP request via AbortController.
 *
 * Lines not yet processed fall through to the uncategorized-expenses account
 * (needs_review) — the bookkeeper can triage them in the review screen.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id")
    .eq("id", jobId)
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

  if (job.status !== "executing") {
    return NextResponse.json(
      { error: `Job is not currently executing (status: ${job.status})` },
      { status: 400 }
    );
  }

  await service
    .from("reclass_jobs")
    .update({ error_message: "[skip_ai]" } as any)
    .eq("id", jobId);

  return NextResponse.json({ ok: true });
}
