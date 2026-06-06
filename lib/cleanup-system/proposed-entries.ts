/**
 * Proposed entries staging — mirrors reclassifications pattern.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CleanupModule, MatchResult, PeriodImpact, ProposedEntryType } from "./types";
import { confidenceToDecision } from "./matching-engine";

export interface ProposedEntryInput {
  runId: string;
  clientLinkId: string;
  module: CleanupModule;
  entryType: ProposedEntryType;
  match?: MatchResult;
  reconMatchId?: string;
  amount?: number;
  txnDate?: string;
  memo?: string;
  qboTransactionId?: string;
  qboTransactionType?: string;
  fromAccountId?: string;
  fromAccountName?: string;
  toAccountId?: string;
  toAccountName?: string;
  jeLines?: Array<{ side: string; account_hint: string; amount: number; description?: string }>;
  periodImpact?: PeriodImpact;
  skipReason?: string;
  cpaFlagId?: string;
  /** When set, bypasses confidence-based decision (UF/AR matchers). */
  decisionOverride?: string;
  /** JSON metadata (UF match, AR duplicate) — stored in ai_reasoning. */
  aiReasoning?: string;
  confidenceOverride?: number;
}

export function buildIdempotencyKey(input: ProposedEntryInput): string {
  const parts = [
    input.runId,
    input.module,
    input.entryType,
    input.qboTransactionId || "no-txn",
    input.qboTransactionType || "",
    String(input.amount || 0),
    input.txnDate || "",
    input.fromAccountId || "",
    input.toAccountId || "",
  ];
  return parts.join(":");
}

export async function createProposedEntry(
  service: SupabaseClient,
  input: ProposedEntryInput
): Promise<string> {
  const confidence = input.confidenceOverride ?? input.match?.confidence ?? 0;
  const decision =
    input.decisionOverride ||
    (input.skipReason
      ? "skip"
      : input.cpaFlagId
      ? "flagged"
      : confidenceToDecision(confidence));

  const idempotencyKey = buildIdempotencyKey(input);

  const { data, error } = await service
    .from("proposed_entries")
    .insert({
      run_id: input.runId,
      client_link_id: input.clientLinkId,
      module: input.module,
      recon_match_id: input.reconMatchId || null,
      entry_type: input.entryType,
      decision,
      confidence,
      ai_reasoning:
        input.aiReasoning ||
        input.match?.reasons?.join("; ") ||
        null,
      period_impact: input.periodImpact || "current",
      skip_reason: input.skipReason || null,
      qbo_transaction_id: input.qboTransactionId || null,
      qbo_transaction_type: input.qboTransactionType || null,
      from_account_id: input.fromAccountId || null,
      from_account_name: input.fromAccountName || null,
      to_account_id: input.toAccountId || null,
      to_account_name: input.toAccountName || null,
      je_lines: input.jeLines || null,
      amount: input.amount || null,
      txn_date: input.txnDate || null,
      memo: input.memo || null,
      cpa_flag_id: input.cpaFlagId || null,
      idempotency_key: idempotencyKey,
    } as any)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return idempotencyKey; // already exists
    throw new Error(`Failed to create proposed entry: ${error.message}`);
  }

  return data.id;
}

export async function updateProposedDecision(
  service: SupabaseClient,
  entryId: string,
  decision: string,
  override?: { targetId: string; targetName: string }
): Promise<void> {
  const update: Record<string, unknown> = {
    decision,
    updated_at: new Date().toISOString(),
  };
  if (override) {
    update.bookkeeper_override = true;
    update.bookkeeper_override_target_id = override.targetId;
    update.bookkeeper_override_target_name = override.targetName;
  }
  const { error } = await service
    .from("proposed_entries")
    .update(update as any)
    .eq("id", entryId);
  if (error) throw new Error(error.message);
}
