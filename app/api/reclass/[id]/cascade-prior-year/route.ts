import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/reclass/[id]/cascade-prior-year
 *
 * Spawns a new reclass job covering the year BEFORE the source job's date range.
 * Same workflow / threshold / client / jurisdiction. Reuses the existing
 * /api/reclass/discover endpoint internally so we don't duplicate job-creation
 * or discovery-kickoff logic.
 *
 * Capped at 3 cascades deep to prevent runaway recursion (rare but possible).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: sourceJobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: sourceJob } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", sourceJobId)
    .single();
  if (!sourceJob) return NextResponse.json({ error: "Source job not found" }, { status: 404 });

  if (sourceJob.workflow !== "full_categorization") {
    return NextResponse.json(
      { error: "Cascade is only supported for full_categorization workflow" },
      { status: 400 }
    );
  }

  // Count cascades by walking parent_job_id chain. Cap at 3.
  let chainLength = 1;
  let currentParent: string | null = (sourceJob as any).parent_job_id || null;
  while (currentParent && chainLength < 5) {
    const { data: parent } = await service
      .from("reclass_jobs")
      .select("parent_job_id")
      .eq("id", currentParent)
      .single();
    if (!parent) break;
    chainLength++;
    currentParent = (parent as any).parent_job_id || null;
  }
  if (chainLength >= 3) {
    return NextResponse.json(
      { error: "Already cascaded 3 years back — stop here for safety. Older books rarely need cleanup.", chain_length: chainLength },
      { status: 400 }
    );
  }

  // Compute prior-year date range
  const start = new Date(sourceJob.date_range_start);
  const end = new Date(sourceJob.date_range_end);
  const priorStart = new Date(start);
  priorStart.setUTCFullYear(priorStart.getUTCFullYear() - 1);
  const priorEnd = new Date(end);
  priorEnd.setUTCFullYear(priorEnd.getUTCFullYear() - 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // Proxy to /api/reclass/discover — reuses job creation + discovery kickoff logic.
  // Forward the user's auth cookie so the request is authenticated as them.
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  const cookieHeader = request.headers.get("cookie") || "";

  const discoverRes = await fetch(`${baseUrl}/api/reclass/discover`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
    },
    body: JSON.stringify({
      client_link_id: sourceJob.client_link_id,
      workflow: "full_categorization",
      date_range_start: fmt(priorStart),
      date_range_end: fmt(priorEnd),
      jurisdiction: sourceJob.jurisdiction,
      state_province: sourceJob.state_province,
      auto_approve_threshold: (sourceJob as any).auto_approve_threshold,
    }),
  });

  const data = await discoverRes.json();
  if (!discoverRes.ok) {
    return NextResponse.json(
      { error: data?.error || "Failed to spawn cascade job" },
      { status: discoverRes.status }
    );
  }

  // Stamp parent_job_id on the new job so we can compute chain length on the next cascade
  if (data.job_id) {
    await service
      .from("reclass_jobs")
      .update({ parent_job_id: sourceJobId } as any)
      .eq("id", data.job_id);
  }

  return NextResponse.json({
    job_id: data.job_id,
    prior_year: priorStart.getUTCFullYear(),
    date_range_start: fmt(priorStart),
    date_range_end: fmt(priorEnd),
    chain_length: chainLength + 1,
  });
}
