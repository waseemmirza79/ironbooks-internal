import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";
import { postReclassComplete } from "@/lib/double";

/**
 * POST /api/reclass/[id]/execute
 *
 * Validates attestation. Kicks off background execution.
 * Returns immediately.
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

  // Pre-execution checks
  if (!job.attested) {
    return NextResponse.json(
      { error: "Bookkeeper attestation required before execution" },
      { status: 400 }
    );
  }
  if (job.status === "executing") {
    return NextResponse.json({ message: "Already executing", started: false });
  }
  if (job.status === "complete") {
    return NextResponse.json({ message: "Already complete", started: false });
  }

  // Mark as executing
  await service
    .from("reclass_jobs")
    .update({
      status: "executing",
      execution_started_at: new Date().toISOString(),
    } as any)
    .eq("id", id);

  // Schedule background execution
  after(async () => {
    try {
      await executeReclass(id);
    } catch (err: any) {
      console.error(`Reclass execution failed for ${id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("reclass_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          execution_completed_at: new Date().toISOString(),
        } as any)
        .eq("id", id);

      await svc.from("audit_log").insert({
        event_type: "reclass_job_failed",
        user_id: user.id,
        request_payload: { reclass_job_id: id, error: err.message } as any,
      });
    }
  });

  return NextResponse.json({ started: true, job_id: id });
}

// ============== BACKGROUND EXECUTION ==============

async function executeReclass(jobId: string) {
  const service = createServiceSupabase();
  const startTime = Date.now();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("*, client_links(*), users:bookkeeper_id(full_name)")
    .eq("id", jobId)
    .single();
  if (!job) throw new Error("Job not found");
  const clientLink = (job as any).client_links;
  const bookkeeperName = (job as any).users?.full_name || "Ironbooks";

  // Audit start
  await service.from("audit_log").insert({
    event_type: "reclass_job_start",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: jobId,
      workflow: job.workflow,
      source: job.source_account_name,
      target: job.target_account_name,
      reason: job.reason,
    } as any,
  });

  const accessToken = await getValidToken(clientLink.id, service as any);

  // Fetch rows to process: decision in (auto_approve, approved)
  // Already-skipped rows stay skipped. Rejected rows don't execute.
  const { data: rows } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", jobId)
    .in("decision", ["auto_approve", "approved"]);

  if (!rows || rows.length === 0) {
    await service
      .from("reclass_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        execution_duration_seconds: 0,
        transactions_moved: 0,
        error_message: "No approved transactions to execute",
      } as any)
      .eq("id", jobId);
    return;
  }

  // Group rows by (transaction_id, transaction_type) so we update each tx once
  // even if multiple lines on it get reclassified
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
  const errors: string[] = [];

  for (const row of rows) {
    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    if (!targetId) {
      failed++;
      errors.push(`${row.qbo_transaction_type}/${row.qbo_transaction_id}: no target account ID for line ${row.line_id}`);
      await service
        .from("reclassifications")
        .update({ status: "failed", error_message: "No target account ID set" } as any)
        .eq("id", row.id);
      continue;
    }

    const key = `${row.qbo_transaction_type}::${row.qbo_transaction_id}`;
    let entry = txMap.get(key);
    if (!entry) {
      entry = {
        tx_type: row.qbo_transaction_type as SupportedTxType,
        tx_id: row.qbo_transaction_id,
        lines: [],
      };
      txMap.set(key, entry);
    }
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    entry.lines.push({
      line_id: row.line_id || "",
      new_account_id: targetId,
      new_account_name: targetName,
      reclass_row_id: row.id,
    });
  }

  const auditMemo = buildAuditMemo(bookkeeperName, job.reason);

  let moved = 0;

  // Execute each transaction update (sequential to respect QBO rate limits)
  const transactions = Array.from(txMap.values());
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];

    // Progress event every 10 txs
    if (i % 10 === 0) {
      await service.from("audit_log").insert({
        event_type: "reclass_progress",
        user_id: job.bookkeeper_id,
        request_payload: {
          reclass_job_id: jobId,
          message: `Processing ${i + 1} of ${transactions.length} transactions`,
          stage: "execute",
          total: transactions.length,
          completed: i,
        } as any,
      });
    }

    try {
      const updated = await reclassifyTransactionLines(
        clientLink.qbo_realm_id,
        accessToken,
        {
          txType: t.tx_type,
          txId: t.tx_id,
          lineUpdates: t.lines,
          auditMemo,
        }
      );

      // Mark all reclass rows for this tx as executed
      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({
            status: "executed",
            executed_at: new Date().toISOString(),
          } as any)
          .eq("id", line.reclass_row_id);
        moved++;
      }
    } catch (err: any) {
      failed += t.lines.length;
      errors.push(`${t.tx_type}/${t.tx_id}: ${err.message}`);

      for (const line of t.lines) {
        await service
          .from("reclassifications")
          .update({
            status: "failed",
            error_message: err.message,
          } as any)
          .eq("id", line.reclass_row_id);
      }
    }
  }

  const durationSec = Math.floor((Date.now() - startTime) / 1000);

  // Sync to Double (best-effort)
  let doubleTaskId: string | null = null;
  try {
    const task = await postReclassComplete(clientLink.double_client_id, {
      sourceAccount: job.source_account_name,
      targetAccount: job.target_account_name || undefined,
      transactionsMoved: moved,
      transactionsSkipped:
        (job.transactions_skipped_reconciled || 0) +
        (job.transactions_skipped_closed || 0),
      bookkeeperName,
      reason: job.reason,
      dateRangeStart: job.date_range_start,
      dateRangeEnd: job.date_range_end,
    });
    if (task) doubleTaskId = String(task.id);
  } catch (err: any) {
    console.warn(`Double sync failed (non-fatal):`, err.message);
    errors.push(`Double sync: ${err.message}`);
  }

  // Finalize
  await service
    .from("reclass_jobs")
    .update({
      status: failed === 0 ? "complete" : "complete", // even with some failures, mark complete - errors recorded per-row
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: durationSec,
      transactions_moved: moved,
      transactions_failed: failed,
      double_task_id: doubleTaskId,
      error_message: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
    } as any)
    .eq("id", jobId);

  await service.from("audit_log").insert({
    event_type: "reclass_job_complete",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: jobId,
      message: `Reclassification complete: ${moved} moved, ${failed} failed`,
      moved,
      failed,
      duration_seconds: durationSec,
    } as any,
  });
}

export const maxDuration = 300;
