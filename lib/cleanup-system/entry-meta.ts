/**
 * Structured metadata stored in proposed_entries.ai_reasoning (JSON).
 */

import type { MatchKind } from "@/lib/uf-ar-matcher";

export interface UfEntryMeta {
  v: 1;
  type: "uf_match";
  kind: MatchKind;
  reasoning: string;
  customer_name: string | null;
  payment_id: string;
  proposed_invoice_id: string | null;
  proposed_doc_number: string | null;
  candidates: Array<{
    qbo_invoice_id: string;
    doc_number: string | null;
    balance: number;
    customer_name: string | null;
    txn_date: string;
  }>;
}

export interface ArDuplicateMeta {
  v: 1;
  type: "ar_duplicate";
  reasoning: string;
  survivor_invoice_id: string;
  survivor_doc_number: string | null;
  confidence: number;
}

export function serializeMeta(meta: UfEntryMeta | ArDuplicateMeta): string {
  return JSON.stringify(meta);
}

export function parseEntryMeta(
  aiReasoning: string | null | undefined
): UfEntryMeta | ArDuplicateMeta | null {
  if (!aiReasoning) return null;
  try {
    const parsed = JSON.parse(aiReasoning);
    if (parsed?.v === 1 && (parsed.type === "uf_match" || parsed.type === "ar_duplicate")) {
      return parsed;
    }
  } catch {
    /* legacy plain-text reasoning */
  }
  return null;
}

export function ufKindToDecision(kind: MatchKind): string {
  switch (kind) {
    case "exact_invoice_number":
    case "high_confidence":
      return "auto_approve";
    case "low_confidence":
      return "needs_review";
    case "unmatched":
      return "flagged";
    default:
      return "needs_review";
  }
}

export function duplicateConfidenceToDecision(confidence: number): string {
  if (confidence >= 0.9) return "auto_approve";
  if (confidence >= 0.75) return "needs_review";
  return "flagged";
}
