import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";

/**
 * POST /api/reclass/[id]/re-execute
 *
 * Re-runs execution for rows that are approved but not yet executed (status='pending').
 * Used after the bookkeeper assigns target accounts to rows that bounced from the
 * initial execute (no target selected before approval).
 *
 * Unlike /execute:
 *   - Job must be "complete" (already ran at least once)
 *   - No attestation check (already attested for the original run)
 *   - Only touches rows with status='pending' — never re-executes already-executed rows
 *   - Job stays in "complete" status; transactions_moved is incremented
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
    .select("*")
    .eq("id", id)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (job.status === "executing") {
    return NextResponse.json({ error: "Job is currently executing — wait for it to finish" }, { status: 409 });
  }
  if (job.status !== "complete") {
    return NextResponse.json(
      { error: `Job is in '${job.status}' status — re-execute is only available for complete jobs` },
      { status: 400 }
    );
  }

  // Check there's actually something to do
  const { count } = await service
    .from("reclassifications")
    .select("id", { count: "exact", head: true })
    .eq("reclass_job_id", id)
    .in("decision", ["approved", "auto_approve"])
    .neq("status", "executed");

  if (!count || count === 0) {
    return NextResponse.json({ error: "No pending rows to execute — all approved rows are already done" }, { status: 400 });
  }

  // Temporarily mark as executing so the UI shows activity
  await service
    .from("reclass_jobs")
    .update({ status: "executing", execution_started_at: new Date().toISOString() } as any)
    .eq("id", id);

  after(async () => {
    try {
      await runReExecute(id, user.id);
    } catch (err: any) {
      console.error(`Re-execute failed for ${id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("reclass_jobs")
        .update({
          status: "complete",
          error_message: `Re-execute error: ${err.message}`,
        } as any)
        .eq("id", id);
    }
  });

  return NextResponse.json({ started: true, job_id: id, pending_rows: count });
}

async function runReExecute(jobId: string, userId: string) {
  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*), users:bookkeeper_id(full_name)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;
  const bookkeeperName = (job as any).users?.full_name || "Ironbooks";

  const accessToken = await getValidToken(clientLink.id, service as any);

  // Resolve master COA names → live QBO account IDs
  const allQboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const accountNameToId = new Map<string, string>(
    allQboAccounts
      .filter((a) => a.Active !== false)
      .map((a) => [a.Name.toLowerCase(), a.Id])
  );

  // Only pending rows (not yet executed)
  const { data: rows } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", jobId)
    .in("decision", ["approved", "auto_approve"])
    .neq("status", "executed");

  if (!rows || rows.length === 0) return;

  const txMap = new Map<
    string,
    {
      tx_type: SupportedTxType;
      tx_id: string;
      lines: Array<{
        line_id: string;
        new_account_id: string;
        new_account_name: string;
        reclass_row_id: string;
      }>;
    }
  >();

  let failed = 0;
  let needsTarget = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const overrideName = row.bookkeeper_override_target_name || null;
    const overrideId = row.bookkeeper_override_target_id || null;
    let targetId: string | null = overrideId || row.to_account_id || null;
    let targetName: string | null = overrideName || row.to_account_name || null;

    if (!targetId && targetName) {
      const resolvedId = accountNameToId.get(targetName.toLowerCase());
      if (resolvedId) targetId = resolvedId;
    }

    if (!targetId) {
      needsTarget++;
      await service
        .from("reclassifications")
        .update({
          decision: "needs_review",
          status: "pending",
          error_message: "Target account required — assign in the review screen and re-run.",
        } as any)
        .eq("id", row.id);
      continue;
    }

    const key = `${row.qbo_transaction_type}::${row.qbo_transaction_id}`;
    let entry = txMap.get(key);
    if (!entry) {
      entry = { tx_type: row.qbo_transaction_type as SupportedTxType, tx_id: row.qbo_transaction_id, lines: [] };
      txMap.set(key, entry);
    }
    entry.lines.push({
      line_id: row.line_id || "",
      new_account_id: targetId,
      new_account_name: targetName || "",
      reclass_row_id: row.id,
    });
  }

  const auditMemo = buildAuditMemo(bookkeeperName, job.reason);
  let moved = 0;

  for (const t of Array.from(txMap.values())) {
    try {
      await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
        txType: t.tx_type,
        txId: t.tx_id,
        lineUpdates: t.lines,
        auditMemo,
      });
      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({ status: "executed", executed_at: new Date().toISOString() } as any)
          .eq("id", line.reclass_row_id);
        moved++;
      }
    } catch (err: any) {
      failed += t.lines.length;
      errors.push(`${t.tx_type}/${t.tx_id}: ${err.message}`);
      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({ status: "failed", error_message: err.message } as any)
          .eq("id", line.reclass_row_id);
      }
    }
  }

  const summaryParts: string[] = [];
  if (needsTarget > 0) {
    summaryParts.push(`${needsTarget} transaction${needsTarget === 1 ? "" : "s"} still need a target account — assign in the review screen.`);
  }
  summaryParts.push(...errors.slice(0, 5));

  await service
    .from("reclass_jobs")
    .update({
      status: "complete",
      transactions_moved: (job.transactions_moved || 0) + moved,
      transactions_failed: failed,
      execution_completed_at: new Date().toISOString(),
      error_message: summaryParts.length > 0 ? summaryParts.join("; ") : null,
    } as any)
    .eq("id", jobId);

  await service.from("audit_log").insert({
    event_type: "reclass_job_re_execute",
    user_id: userId,
    request_payload: { reclass_job_id: jobId, moved, failed, needs_target: needsTarget } as any,
  });
}

export const maxDuration = 300;
