import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/close-month
 *
 * Stamps month_closed_at on the most recent reclass job for this client.
 * Moves the MoM kanban card to "Month Closed".
 *
 * Body: { reclass_job_id: string }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { reclass_job_id, build_package } = body;
  if (!reclass_job_id) {
    return NextResponse.json({ error: "reclass_job_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  const { data: jobRaw } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, status, month_closed_at, date_range_end")
    .eq("id", reclass_job_id)
    .eq("client_link_id", clientId)
    .single();
  const job = jobRaw as any;

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.month_closed_at) {
    return NextResponse.json({ error: "Month already closed" }, { status: 400 });
  }

  const now = new Date().toISOString();
  await service
    .from("reclass_jobs")
    .update({
      month_closed_at: now,
      month_closed_by: user.id,
    } as any)
    .eq("id", reclass_job_id);

  let packageId: string | undefined;
  if (build_package) {
    try {
      const end = new Date(job.date_range_end + "T00:00:00");
      const { upsertDraftPackage } = await import("@/lib/month-end/package-builder");
      const result = await upsertDraftPackage(
        service,
        clientId,
        { periodYear: end.getFullYear(), periodMonth: end.getMonth() + 1 },
        user.id
      );
      packageId = result.packageId;
    } catch (err: any) {
      console.warn("[close-month] package build failed:", err?.message);
    }
  }

  return NextResponse.json({ ok: true, package_id: packageId });
}
