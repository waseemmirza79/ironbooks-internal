/**
 * POST /api/jobs/[id]/merges/[mergeId]/action
 *
 * Per-merge action handler called from the live execution / Manual Cleanup
 * Report screen. Operates on ONE merge candidate at a time.
 *
 * Body shapes:
 *   { action: "execute", winner_id?: string }     // run the merge
 *   { action: "rename",  new_name: string }       // rename source(s) to a non-colliding name
 *   { action: "ignore"  }                          // mark this merge as ignored
 *   { action: "retry"   }                          // retry a failed merge from scratch
 *
 * For execute / retry:
 *   1. For each source account NOT the winner:
 *      - Pull its transactions
 *      - Reclassify them all to the winner / target
 *      - If reclass fully succeeds, inactivate the source
 *      - If reclass partially fails, store the error and STOP (status = failed)
 *   2. If the winner needs renaming (Scenario 2), rename it to target_name
 *   3. Update merge_candidates[i] in-place to status complete/failed
 *
 * All updates use a read-modify-write pattern on the coa_jobs.merge_candidates
 * JSONB array. Concurrent calls on different merges within the same job are
 * safe in practice (Lisa is one user clicking sequentially), but we don't
 * try to make it atomic across merges.
 *
 * Returns the updated merge candidate JSON.
 */

import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  getValidToken,
  fetchAllAccounts,
  renameAccount,
  inactivateAccount,
  qboErrorResponse,
} from "@/lib/qbo";
import {
  fetchTransactionsForAccount,
  reclassifyTransactionLines,
  buildAuditMemo,
  type ReclassLine,
} from "@/lib/qbo-reclass";

// Wide date range — we want every transaction the account has ever been used in
const TX_DATE_START = "1900-01-01";
const TX_DATE_END = "2099-12-31";

export const maxDuration = 300;

interface MergeCandidate {
  id: string;
  type: "existing_target" | "new_consolidation";
  target_name: string;
  target_account_id: string | null;
  source_accounts: Array<{
    id: string;
    name: string;
    transaction_count: number;
    balance: number;
  }>;
  recommended_winner_id: string | null;
  status: "pending" | "in_progress" | "complete" | "failed" | "ignored";
  error_message: string | null;
  completed_at: string | null;
  user_choice: any;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; mergeId: string }> }
) {
  const { id: jobId, mergeId } = await context.params;
  const body = await request.json();
  const action: string = body.action;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Load job + the specific merge candidate
  const { data: job, error: jobErr } = await service
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const candidates: MergeCandidate[] = ((job as any).merge_candidates as any) || [];
  const idx = candidates.findIndex((c) => c.id === mergeId);
  if (idx === -1) {
    return NextResponse.json({ error: "Merge candidate not found" }, { status: 404 });
  }

  const candidate = candidates[idx];
  const clientLink = (job as any).client_links;
  if (!clientLink) {
    return NextResponse.json({ error: "Client link missing" }, { status: 500 });
  }

  // Dispatch
  try {
    if (action === "ignore") {
      candidates[idx] = {
        ...candidate,
        status: "ignored",
        completed_at: new Date().toISOString(),
        user_choice: { action: "ignore" },
      };
    } else if (action === "rename") {
      // User wants to rename source(s) to a non-colliding name and skip the merge.
      // We treat this as: do a normal QBO rename on each source to the new name,
      // then mark merge complete. Caller must supply a UNIQUE name (basic check below).
      const newName: string = String(body.new_name || "").trim();
      if (!newName) {
        return NextResponse.json({ error: "new_name required" }, { status: 400 });
      }
      const accessToken = await getValidToken(clientLink.id, service as any);
      const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const nameExists = allAccounts.some(
        (a: any) =>
          a.Active !== false &&
          a.Name?.toLowerCase().trim() === newName.toLowerCase() &&
          !candidate.source_accounts.find((s) => s.id === a.Id)
      );
      if (nameExists) {
        return NextResponse.json(
          { error: `An account named "${newName}" already exists. Pick a unique name.` },
          { status: 400 }
        );
      }

      // Rename only the first source to the new name (assumption: user wants
      // ONE renamed thing, not all duplicates renamed identically — they
      // can re-run cleanup to handle the others)
      const winnerId = body.winner_id || candidate.recommended_winner_id || candidate.source_accounts[0].id;
      const winnerSnap: any = allAccounts.find((a: any) => a.Id === winnerId);
      if (!winnerSnap) {
        return NextResponse.json({ error: "Winner account not found in QBO" }, { status: 404 });
      }
      await renameAccount(
        clientLink.qbo_realm_id,
        accessToken,
        winnerId,
        winnerSnap.SyncToken,
        newName,
        winnerSnap
      );

      candidates[idx] = {
        ...candidate,
        status: "complete",
        completed_at: new Date().toISOString(),
        user_choice: { action: "rename", new_name: newName, winner_id: winnerId },
      };
    } else if (action === "execute" || action === "retry") {
      // Run the merge. Strategy:
      //   - For Scenario 1 (existing target): winner = target_account_id. All
      //     sources get drained into it, then inactivated.
      //   - For Scenario 2 (new consolidation): winner = user-supplied or
      //     recommended. Rename winner to target_name. Drain all OTHER sources
      //     into winner, then inactivate them.
      candidates[idx] = { ...candidate, status: "in_progress", error_message: null };
      await service
        .from("coa_jobs")
        .update({ merge_candidates: candidates as any })
        .eq("id", jobId);

      const accessToken = await getValidToken(clientLink.id, service as any);
      const allAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
      const accountMap = new Map<string, any>(allAccounts.map((a: any) => [a.Id, a]));

      const winnerId =
        candidate.type === "existing_target"
          ? candidate.target_account_id!
          : String(body.winner_id || candidate.recommended_winner_id);

      const sourcesToDrain = candidate.source_accounts.filter((s) => s.id !== winnerId);

      let totalMoved = 0;
      let totalFailed = 0;
      const inactivated: string[] = [];

      for (const src of sourcesToDrain) {
        const { lines } = await fetchTransactionsForAccount(
          clientLink.qbo_realm_id,
          accessToken,
          src.id,
          TX_DATE_START,
          TX_DATE_END
        );

        // Group by transaction id (a tx may have multiple lines hitting the source)
        const byTxn = new Map<string, ReclassLine[]>();
        for (const ln of lines) {
          if (!byTxn.has(ln.tx_id)) byTxn.set(ln.tx_id, []);
          byTxn.get(ln.tx_id)!.push(ln);
        }

        let movedForThisSource = 0;
        const failedForThisSource: string[] = [];

        for (const [txId, txLines] of byTxn) {
          try {
            await reclassifyTransactionLines(
              clientLink.qbo_realm_id,
              accessToken,
              {
                txType: txLines[0].tx_type as any,
                txId,
                lineUpdates: txLines.map((ln) => ({
                  line_id: ln.line_id,
                  new_account_id: winnerId,
                  new_account_name: candidate.target_name,
                })),
                auditMemo: buildAuditMemo(
                  src.name,
                  candidate.target_name,
                  "Ironbooks merge"
                ),
              }
            );
            movedForThisSource += txLines.length;
          } catch (e: any) {
            failedForThisSource.push(`tx ${txId}: ${e.message || e}`);
          }
        }

        totalMoved += movedForThisSource;
        totalFailed += failedForThisSource.length;

        // Only inactivate the source if EVERY transaction moved successfully
        if (failedForThisSource.length === 0) {
          const snap = accountMap.get(src.id);
          if (snap) {
            try {
              await inactivateAccount(
                clientLink.qbo_realm_id,
                accessToken,
                src.id,
                snap.SyncToken,
                snap
              );
              inactivated.push(src.id);
            } catch (e: any) {
              // Reclass succeeded but inactivate failed — record and stop
              throw new Error(
                `Reclassified ${movedForThisSource} transactions out of "${src.name}", but inactivation failed: ${e.message || e}`
              );
            }
          }
        } else {
          throw new Error(
            `Could not move all transactions from "${src.name}" — ${failedForThisSource.length} of ${byTxn.size} failed. ` +
            `First error: ${failedForThisSource[0]}`
          );
        }
      }

      // Scenario 2: rename winner to target_name (only if winner isn't already that name)
      if (candidate.type === "new_consolidation") {
        const winnerSnap = accountMap.get(winnerId);
        if (winnerSnap && winnerSnap.Name !== candidate.target_name) {
          try {
            await renameAccount(
              clientLink.qbo_realm_id,
              accessToken,
              winnerId,
              winnerSnap.SyncToken,
              candidate.target_name,
              winnerSnap
            );
          } catch (e: any) {
            throw new Error(
              `Transactions merged into winner, but rename to "${candidate.target_name}" failed: ${e.message || e}`
            );
          }
        }
      }

      candidates[idx] = {
        ...candidate,
        status: "complete",
        error_message: null,
        completed_at: new Date().toISOString(),
        user_choice: {
          action,
          winner_id: winnerId,
          transactions_moved: totalMoved,
          accounts_inactivated: inactivated,
        },
      };

      // Audit trail
      await service.from("audit_log").insert({
        job_id: jobId,
        user_id: user.id,
        event_type: "merge_complete",
        request_payload: {
          merge_id: mergeId,
          winner_id: winnerId,
          target_name: candidate.target_name,
        } as any,
        response_payload: {
          transactions_moved: totalMoved,
          inactivated_account_ids: inactivated,
        } as any,
        occurred_at: new Date().toISOString(),
      });
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Persist updated candidates
    await service
      .from("coa_jobs")
      .update({ merge_candidates: candidates as any })
      .eq("id", jobId);

    return NextResponse.json({ success: true, merge: candidates[idx] });
  } catch (e: any) {
    // Mark merge failed with the error message, persist, return error
    candidates[idx] = {
      ...candidates[idx],
      status: "failed",
      error_message: String(e?.message || e),
    };
    await service
      .from("coa_jobs")
      .update({ merge_candidates: candidates as any })
      .eq("id", jobId);

    await service.from("audit_log").insert({
      job_id: jobId,
      user_id: user.id,
      event_type: "merge_failed",
      request_payload: { merge_id: mergeId, action } as any,
      response_payload: { error: String(e?.message || e) } as any,
      occurred_at: new Date().toISOString(),
    });

    return qboErrorResponse(e);
  }
}
