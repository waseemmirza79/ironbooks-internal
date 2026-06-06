/**
 * Shared matching engine — tiers 1–5.
 * Deterministic money math; stop at first confident match.
 */

import type { MatchResult } from "./types";

const CONFIDENCE_THRESHOLD = 0.7;
const DATE_WINDOW_DAYS = 7;
const AMOUNT_TOLERANCE = 0.02;

export interface MatchCandidate {
  id: string;
  amount: number;
  date: string | null;
  payer: string | null;
  reference: string | null;
  fee?: number;
  tax?: number;
  payout_id?: string | null;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(a).getTime() - new Date(b).getTime()) / 86400000
  );
}

function amountsMatch(a: number, b: number, tolerance = AMOUNT_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance || Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) < 0.01;
}

function normalizePayer(name: string | null): string {
  if (!name) return "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
}

/** Tier 1: Exact reference + amount */
export function matchExact(
  source: MatchCandidate,
  targets: MatchCandidate[]
): MatchResult | null {
  for (const t of targets) {
    if (
      source.reference &&
      t.reference &&
      source.reference === t.reference &&
      amountsMatch(source.amount, t.amount)
    ) {
      return {
        match_type: "exact_reference_amount",
        confidence: 0.99,
        gross_amount: source.amount,
        fee_amount: source.fee || 0,
        tax_amount: source.tax || 0,
        net_amount: source.amount - (source.fee || 0) - (source.tax || 0),
        proposed_fix: { action: "link", target_id: t.id },
        reasons: [`Exact reference match: ${source.reference}`],
        source_record_ids: [source.id],
        qbo_refs: { target_id: t.id },
      };
    }
  }
  return null;
}

/** Tier 2: Amount + payer + date window */
export function matchAmountPayerDate(
  source: MatchCandidate,
  targets: MatchCandidate[]
): MatchResult | null {
  const srcPayer = normalizePayer(source.payer);
  for (const t of targets) {
    if (!amountsMatch(source.amount, t.amount)) continue;
    if (srcPayer && normalizePayer(t.payer) !== srcPayer) continue;
    if (source.date && t.date && daysBetween(source.date, t.date) > DATE_WINDOW_DAYS) continue;

    return {
      match_type: "amount_payer_date",
      confidence: 0.92,
      gross_amount: source.amount,
      fee_amount: source.fee || 0,
      tax_amount: source.tax || 0,
      net_amount: source.amount - (source.fee || 0),
      proposed_fix: { action: "link", target_id: t.id },
      reasons: [`Amount $${source.amount} + payer match within ${DATE_WINDOW_DAYS}d`],
      source_record_ids: [source.id],
      qbo_refs: { target_id: t.id },
    };
  }
  return null;
}

/** Tier 3: Fee/tax-adjusted (net ≈ gross − fee) */
export function matchFeeAdjusted(
  source: MatchCandidate,
  targets: MatchCandidate[]
): MatchResult | null {
  const net = source.amount - (source.fee || 0) - (source.tax || 0);
  for (const t of targets) {
    if (amountsMatch(net, t.amount)) {
      return {
        match_type: "fee_adjusted",
        confidence: 0.88,
        gross_amount: source.amount,
        fee_amount: source.fee || 0,
        tax_amount: source.tax || 0,
        net_amount: net,
        proposed_fix: { action: "deposit_with_fee", target_id: t.id, fee: source.fee || 0 },
        reasons: [`Net $${net.toFixed(2)} = gross $${source.amount} − fee $${source.fee || 0}`],
        source_record_ids: [source.id],
        qbo_refs: { target_id: t.id },
      };
    }
  }
  return null;
}

/** Tier 4: Batch/payout (many-to-one) */
export function matchBatchPayout(
  sources: MatchCandidate[],
  target: MatchCandidate
): MatchResult | null {
  if (!target.payout_id && sources.length < 2) return null;

  const totalNet = sources.reduce(
    (sum, s) => sum + s.amount - (s.fee || 0) - (s.tax || 0),
    0
  );
  if (!amountsMatch(totalNet, target.amount)) return null;

  return {
    match_type: "batch_payout",
    confidence: 0.85,
    gross_amount: sources.reduce((s, x) => s + x.amount, 0),
    fee_amount: sources.reduce((s, x) => s + (x.fee || 0), 0),
    tax_amount: sources.reduce((s, x) => s + (x.tax || 0), 0),
    net_amount: totalNet,
    proposed_fix: {
      action: "batch_deposit",
      target_id: target.id,
      source_ids: sources.map((s) => s.id),
    },
    reasons: [`${sources.length} records sum to $${totalNet.toFixed(2)} = payout $${target.amount}`],
    source_record_ids: sources.map((s) => s.id),
    qbo_refs: { target_id: target.id },
  };
}

/** Tier 5: Fuzzy name + amount (partial/installment) */
export function matchFuzzy(
  source: MatchCandidate,
  targets: MatchCandidate[]
): MatchResult | null {
  const srcPayer = normalizePayer(source.payer);
  if (!srcPayer) return null;

  for (const t of targets) {
    const tgtPayer = normalizePayer(t.payer);
    if (!tgtPayer) continue;
    const nameOverlap =
      srcPayer.includes(tgtPayer.slice(0, 8)) ||
      tgtPayer.includes(srcPayer.slice(0, 8));
    if (!nameOverlap) continue;
    if (!amountsMatch(source.amount, t.amount, 1.0)) continue;

    return {
      match_type: "fuzzy_name_amount",
      confidence: 0.75,
      gross_amount: source.amount,
      fee_amount: source.fee || 0,
      tax_amount: source.tax || 0,
      net_amount: source.amount - (source.fee || 0),
      proposed_fix: { action: "link", target_id: t.id },
      reasons: [`Fuzzy payer match: "${source.payer}" ≈ "${t.payer}"`],
      source_record_ids: [source.id],
      qbo_refs: { target_id: t.id },
    };
  }
  return null;
}

/** Run all tiers in order; stop at first match above threshold. */
export function findBestMatch(
  source: MatchCandidate,
  targets: MatchCandidate[],
  allSources?: MatchCandidate[]
): MatchResult | null {
  const tiers = [
    () => matchExact(source, targets),
    () => matchAmountPayerDate(source, targets),
    () => matchFeeAdjusted(source, targets),
    () => matchFuzzy(source, targets),
  ];

  for (const tier of tiers) {
    const result = tier();
    if (result && result.confidence >= CONFIDENCE_THRESHOLD) return result;
  }

  // Tier 4: batch — only if we have sibling sources sharing a payout_id
  if (allSources && source.payout_id) {
    const siblings = allSources.filter((s) => s.payout_id === source.payout_id);
    const payoutTarget = targets.find((t) => t.payout_id === source.payout_id);
    if (siblings.length > 1 && payoutTarget) {
      const batch = matchBatchPayout(siblings, payoutTarget);
      if (batch) return batch;
    }
  }

  return null;
}

export function confidenceToDecision(confidence: number): string {
  if (confidence >= 0.95) return "auto_approve";
  if (confidence >= 0.7) return "needs_review";
  return "flagged";
}
