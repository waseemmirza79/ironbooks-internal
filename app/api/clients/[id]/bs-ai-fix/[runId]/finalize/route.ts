import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createJournalEntry, fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { reclassifyTransactionLines } from "@/lib/qbo-reclass";
import type { ProposedFix } from "@/lib/bs-ai-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/clients/[id]/bs-ai-fix/[runId]/finalize
 *
 * Execute every accepted/modified item in the run:
 *   - reclass_lines  → reclassifyTransactionLines (existing helper)
 *   - journal_entry  → createJournalEntry (new helper)
 *   - flag_for_manual → skipped; left as accepted for visibility but no QBO write
 *
 * Each item gets per-item try/catch so one failure doesn't poison the
 * batch. Results are written back to bs_ai_fix_items.execution_result /
 * execution_error and the run row's status flips to finalized when done.
 *
 * Owner bookkeeper or admin/lead only.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: clientLinkId, runId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Pull every accepted/modified item that hasn't been executed yet
  const { data: items } = await service
    .from("bs_ai_fix_items" as any)
    .select("*")
    .eq("run_id", runId)
    .in("decision", ["accepted", "modified"]);
  const queue = ((items as any[]) || []).filter(
    (i) => i.decision !== "executed" && i.decision !== "failed"
  );

  if (queue.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No accepted/modified items to execute.",
      executed: 0,
      failed: 0,
    });
  }

  let accessToken: string;
  let allAccounts;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return qboErrorResponse(err);
  }
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));

  await service
    .from("bs_ai_fix_runs" as any)
    .update({ status: "finalizing" } as any)
    .eq("id", runId);

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const auditPrefix = `Ironbooks AI BS cleanup (by ${bookkeeperName})`;
  let executedCount = 0;
  let failedCount = 0;
  const results: any[] = [];

  for (const item of queue) {
    const fix: ProposedFix =
      (item.decision === "modified" && item.modified_fix) || item.proposed_fix;

    try {
      if (fix.type === "flag_for_manual") {
        // Flagged items have no QBO write — mark executed for bookkeeping
        await service
          .from("bs_ai_fix_items" as any)
          .update({
            decision: "executed",
            executed_at: new Date().toISOString(),
            execution_result: { type: "flag_for_manual_acknowledged" },
          } as any)
          .eq("id", item.id);
        executedCount++;
        results.push({ id: item.id, status: "ok", type: "flag" });
        continue;
      }

      if (fix.type === "reclass_lines") {
        // Defensive: empty arrays would silently mark "executed" but do
        // nothing. Catch them here so the bookkeeper sees the failure
        // rather than a false-positive green checkmark.
        if (!Array.isArray(fix.lines) || fix.lines.length === 0) {
          throw new Error("Fix has no reclass lines — nothing to execute");
        }
        // Validate each line's target account exists + active
        for (const ln of fix.lines) {
          const tgt = accountById.get(ln.new_account_id);
          if (!tgt) throw new Error(`Target account ${ln.new_account_id} not found in QBO`);
          if (tgt.Active === false) {
            throw new Error(`Target account "${tgt.Name}" is inactive`);
          }
        }

        // Group lines by transaction so each tx gets one sparse-update call
        const byTx = new Map<string, typeof fix.lines>();
        for (const ln of fix.lines) {
          const key = ln.qbo_transaction_id;
          if (!byTx.has(key)) byTx.set(key, []);
          byTx.get(key)!.push(ln);
        }

        for (const [txId, lns] of byTx) {
          const txType = lns[0].qbo_transaction_type;
          await reclassifyTransactionLines(
            (client as any).qbo_realm_id,
            accessToken,
            {
              txType: txType as any,
              txId,
              lineUpdates: lns.map((l) => ({
                line_id: l.qbo_line_id,
                new_account_id: l.new_account_id,
                new_account_name: l.new_account_name,
              })),
              auditMemo: `${auditPrefix} — ${item.kind}`,
            }
          );
        }

        await service
          .from("bs_ai_fix_items" as any)
          .update({
            decision: "executed",
            executed_at: new Date().toISOString(),
            execution_result: {
              type: "reclass_lines",
              lines_moved: fix.lines.length,
              transactions_touched: byTx.size,
            },
          } as any)
          .eq("id", item.id);
        executedCount++;
        results.push({ id: item.id, status: "ok", type: "reclass", lines: fix.lines.length });
        continue;
      }

      if (fix.type === "journal_entry") {
        if (!fix.je || !Array.isArray(fix.je.lines) || fix.je.lines.length < 2) {
          throw new Error("JE has fewer than 2 lines — invalid double-entry");
        }
        // Validate each JE line's account
        for (const jl of fix.je.lines) {
          const tgt = accountById.get(jl.account_id);
          if (!tgt) throw new Error(`JE account ${jl.account_id} not found in QBO`);
        }

        const created = await createJournalEntry(
          (client as any).qbo_realm_id,
          accessToken,
          {
            txn_date: fix.je.txn_date,
            doc_number: fix.je.doc_number,
            private_note: `${auditPrefix} — ${item.kind}${fix.je.private_note ? ` · ${fix.je.private_note}` : ""}`,
            lines: fix.je.lines.map((l) => ({
              posting_type: l.posting_type,
              amount: l.amount,
              account_id: l.account_id,
              account_name: l.account_name,
              description: l.description,
            })),
          }
        );

        await service
          .from("bs_ai_fix_items" as any)
          .update({
            decision: "executed",
            executed_at: new Date().toISOString(),
            execution_result: {
              type: "journal_entry",
              qbo_je_id: created.Id,
              doc_number: created.DocNumber,
              total: created.TotalAmt,
            },
          } as any)
          .eq("id", item.id);
        executedCount++;
        results.push({ id: item.id, status: "ok", type: "je", qbo_je_id: created.Id });
        continue;
      }

      // Should never reach here, but defend against malformed proposed_fix
      throw new Error(`Unknown fix type: ${(fix as any).type}`);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      await service
        .from("bs_ai_fix_items" as any)
        .update({
          decision: "failed",
          execution_error: errMsg,
        } as any)
        .eq("id", item.id);
      failedCount++;
      results.push({ id: item.id, status: "failed", error: errMsg });
    }
  }

  const finalStatus = failedCount > 0 && executedCount === 0 ? "failed" : "finalized";
  await service
    .from("bs_ai_fix_runs" as any)
    .update({
      status: finalStatus,
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
      finalize_results: { executed: executedCount, failed: failedCount, results },
    } as any)
    .eq("id", runId);

  return NextResponse.json({
    ok: true,
    executed: executedCount,
    failed: failedCount,
    results,
  });
}
