import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { updateProposedDecision } from "@/lib/cleanup-system/proposed-entries";
import { executeProposedEntries } from "@/lib/cleanup-system/execute-proposed";
import { advanceModule } from "@/lib/cleanup-system/orchestrator";
import type { CleanupModule } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/cleanup/[runId]/proposed/[id]/approve-post
 *
 * Approve a single proposed entry AND post it to QuickBooks immediately
 * (synchronously) so the bookkeeper sees the result on the row right away.
 * One QBO write per call, with the same per-entry guards as the batch path
 * (CPA-flag block, idempotency in createJournalEntry, etc.).
 *
 * When this was the last unresolved entry in its module (nothing left that
 * isn't skipped or already executed), the module is advanced so the wizard
 * can move toward QA / Deliver.
 *
 * Body (optional): { override_target_id, override_target_name } — used for UF
 * rows where the bookkeeper picked the invoice on the row before approving.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; id: string }> }
) {
  const { runId, id } = await context.params;

  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: entry } = await service
    .from("proposed_entries")
    .select("id, client_link_id, module, decision, executed")
    .eq("id", id)
    .eq("run_id", runId)
    .single();
  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (entry as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  if ((entry as any).executed) {
    return NextResponse.json({ ok: true, posted: true, alreadyPosted: true });
  }

  const body = await request.json().catch(() => ({} as any));
  const overrideTargetId: string | undefined = body.override_target_id;
  const overrideTargetName: string | undefined = body.override_target_name;

  // 1. Approve (carry an invoice override through if the row supplied one).
  try {
    await updateProposedDecision(
      service,
      id,
      "approved",
      overrideTargetId
        ? { targetId: overrideTargetId, targetName: overrideTargetName || "" }
        : undefined
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // 2. Post this one entry to QBO synchronously.
  let result: { executed: number; failed: number; skipped: number };
  try {
    result = await executeProposedEntries(service, runId, auth.userId, undefined, id);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Posting failed" }, { status: 500 });
  }

  // Re-read to surface the exact QBO outcome (executed flag / error message).
  const { data: after } = await service
    .from("proposed_entries")
    .select("executed, execution_error, qbo_result_id")
    .eq("id", id)
    .single();
  const posted = !!(after as any)?.executed;

  // 3. If nothing unresolved is left in this module (everything is executed or
  //    skipped), advance it so the pipeline can move on.
  if (posted) {
    const { count: remaining } = await service
      .from("proposed_entries")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("module", (entry as any).module)
      .eq("executed", false)
      .neq("decision", "skip");
    if ((remaining || 0) === 0) {
      try {
        await advanceModule(service, runId, (entry as any).module as CleanupModule);
      } catch {
        /* non-fatal — the module just stays open for an explicit advance */
      }
    }
  }

  if (!posted) {
    const reason =
      (after as any)?.execution_error ||
      (result.skipped > 0
        ? "Couldn't post — this entry may need CPA sign-off or is missing a target account."
        : "Couldn't post this entry to QuickBooks.");
    return NextResponse.json(
      { ok: false, posted: false, error: reason, ...result },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true, posted: true, ...result });
}
