import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/cleanup-system/auth";
import { runQAGate, saveQAGateResult } from "@/lib/cleanup-system/qa-gate";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const result = await runQAGate(service, runId, (run as any).client_link_id);
  await saveQAGateResult(service, runId, result);

  return NextResponse.json(result);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("qa_results, qa_passed_at")
    .eq("id", runId)
    .single();

  return NextResponse.json({ qa: (run as any)?.qa_results, passed_at: (run as any)?.qa_passed_at });
}
