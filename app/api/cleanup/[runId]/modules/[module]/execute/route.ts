import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { executeProposedEntries } from "@/lib/cleanup-system/execute-proposed";
import { advanceModule } from "@/lib/cleanup-system/orchestrator";
import type { CleanupModule } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; module: string }> }
) {
  const { runId, module } = await context.params;
  const body = await request.json().catch(() => ({}));
  const { attested } = body;

  if (!attested) {
    return NextResponse.json(
      { error: "attested=true required before executing QBO writes" },
      { status: 400 }
    );
  }

  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id, attested")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (run as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  await service
    .from("cleanup_runs")
    .update({
      attested: true,
      attested_at: new Date().toISOString(),
      attested_by: auth.userId,
      status: "executing",
    } as any)
    .eq("id", runId);

  await service
    .from("cleanup_run_modules")
    .update({ status: "executing" } as any)
    .eq("run_id", runId)
    .eq("module", module as any);

  after(async () => {
    try {
      const result = await executeProposedEntries(
        service,
        runId,
        auth.userId,
        module
      );
      await advanceModule(service, runId, module as CleanupModule);
      await service.from("audit_log").insert({
        event_type: "cleanup_module_executed",
        user_id: auth.userId,
        occurred_at: new Date().toISOString(),
        request_payload: { run_id: runId, module, ...result },
      } as any);
    } catch (err: any) {
      await service
        .from("cleanup_run_modules")
        .update({ status: "failed", error_message: err.message } as any)
        .eq("run_id", runId)
        .eq("module", module as any);
    }
  });

  return NextResponse.json({ ok: true, message: "Execution started" });
}
