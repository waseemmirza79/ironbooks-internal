/**
 * Bank-rule eligibility + grouping — the ONE definition shared by the
 * candidates page (app/reclass/[id]/bank-rules/page.tsx) and the create
 * endpoint (app/api/rules/from-reclass/route.ts).
 *
 * Why this exists (D14): the two sides drifted three separate ways —
 *   1. decision filter: the route excluded `skip` rows while the page
 *      deliberately included them ("already_correct mappings are proven
 *      right"), so all-skip vendors showed as ready candidates and then
 *      silently created nothing;
 *   2. grouping: the page falls back to grouping unknown-vendor rows by bank
 *      DESCRIPTION ("MENARDS #3014") and sends that key as the selection,
 *      but the route grouped only by vendor — description-keyed selections
 *      could never match;
 *   3. sentinel handling ("Unknown vendor" keys, "Uncategorized" targets)
 *      was two hand-synced copies.
 * Every rule about which rows can become rules, and how rows group into rule
 * candidates, lives HERE and only here.
 */

export interface RuleSourceRow {
  vendor_name: string | null;
  vendor_pattern_normalized: string | null;
  description?: string | null;
  decision: string;
  to_account_id: string | null;
  to_account_name: string | null;
  bookkeeper_override_target_id: string | null;
  bookkeeper_override_target_name: string | null;
  transaction_amount: number | null;
}

/**
 * Decisions whose rows may contribute to a rule. `skip` is IN on purpose:
 * skip/already_correct rows are proven-right mappings — ideal rule seeds
 * (other skip flavors carry no target, so they add tx counts but never
 * targets). `rejected` is OUT: the bookkeeper explicitly said the mapping
 * was wrong.
 */
export const RULE_ELIGIBLE_DECISIONS = new Set([
  "auto_approve",
  "approved",
  "needs_review",
  "flagged",
  "ask_client",
  "skip",
]);

/** QBO's literal fallback labels for no-payee transactions — not real vendors. */
const UNKNOWN_VENDOR_KEYS = new Set(["unknown vendor", "unknown", ""]);

const isUnknownVendor = (v: string | null | undefined): boolean =>
  UNKNOWN_VENDOR_KEYS.has(String(v || "").trim().toLowerCase());

/** "Uncategorized" is the review dropdown's flag-for-senior sentinel, not a
 *  real QBO account — never a valid rule target. */
export function isRealRuleTarget(name: string | null | undefined): name is string {
  if (!name) return false;
  const norm = name.trim().toLowerCase();
  return norm !== "" && norm !== "uncategorized";
}

export type RowIneligibleReason = "rejected" | "no_vendor";

/**
 * Grouping key for a row: normalized vendor when real, else the bank
 * DESCRIPTION (uppercased, whitespace-collapsed — mirrors how QBO surfaces
 * bank-feed descriptors), else null (nothing to pattern-match a rule on).
 */
export function ruleGroupKey(
  row: Pick<RuleSourceRow, "vendor_name" | "vendor_pattern_normalized" | "description">
): { key: string; display: string } | null {
  const unknown = isUnknownVendor(row.vendor_name);
  const description = String(row.description || "").trim();
  if (unknown) {
    if (!description) return null;
    return { key: description.toUpperCase().replace(/\s+/g, " "), display: description };
  }
  const key = row.vendor_pattern_normalized || row.vendor_name || "";
  if (!key || isUnknownVendor(key)) return null;
  return { key, display: row.vendor_name || key };
}

/** Row-level ineligibility: why a row can never contribute to any rule. */
export function rowIneligibilityReason(row: RuleSourceRow): RowIneligibleReason | null {
  if (!RULE_ELIGIBLE_DECISIONS.has(row.decision)) return "rejected";
  if (!ruleGroupKey(row)) return "no_vendor";
  return null;
}

export interface RuleCandidate {
  vendorPattern: string; // the group/selection key
  vendorDisplay: string;
  txCount: number; // eligible rows in this group (= coverage if a rule is made)
  totalAmount: number;
  hasTarget: boolean;
  targetAccountId: string; // "" when no target observed
  targetAccountName: string; // "" when no target observed
  sampleDescriptions: string[];
}

export interface RuleCandidateSet {
  candidates: RuleCandidate[];
  /** Row counts excluded from every candidate, by reason — the page's
   *  "N rows can't become rules" panel and nothing else. */
  excluded: { rejected: number; no_vendor: number };
}

/**
 * THE shared grouping: rows → rule candidates. Deterministic; most-frequent
 * real target wins per group; groups whose rows never observed a real target
 * surface with hasTarget=false (page renders "Needs target"; route skips
 * unless an override supplies one).
 */
export function buildRuleCandidates(rows: RuleSourceRow[]): RuleCandidateSet {
  const groups = new Map<
    string,
    {
      display: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
      samples: string[];
    }
  >();
  const excluded = { rejected: 0, no_vendor: 0 };

  for (const row of rows) {
    const reason = rowIneligibilityReason(row);
    if (reason) {
      excluded[reason]++;
      continue;
    }
    const gk = ruleGroupKey(row)!;
    if (!groups.has(gk.key)) {
      groups.set(gk.key, {
        display: gk.display,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
        samples: [],
      });
    }
    const g = groups.get(gk.key)!;
    g.txCount += 1;
    g.totalAmount += row.transaction_amount || 0;
    if (row.vendor_name && g.samples.length < 3 && !g.samples.includes(row.vendor_name)) {
      g.samples.push(row.vendor_name);
    }
    const targetId = row.bookkeeper_override_target_id || row.to_account_id || "";
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (isRealRuleTarget(targetName)) {
      const existing = g.targetCounts.get(targetId);
      if (existing) existing.count += 1;
      else g.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

  const candidates: RuleCandidate[] = [...groups.entries()].map(([key, g]) => {
    let best = { id: "", name: "" };
    let bestCount = 0;
    for (const t of g.targetCounts.values()) {
      if (t.count > bestCount) {
        bestCount = t.count;
        best = { id: t.id, name: t.name };
      }
    }
    return {
      vendorPattern: key,
      vendorDisplay: g.display,
      txCount: g.txCount,
      totalAmount: Math.round(g.totalAmount * 100) / 100,
      hasTarget: !!best.name,
      targetAccountId: best.id,
      targetAccountName: best.name,
      sampleDescriptions: g.samples,
    };
  });

  return { candidates, excluded };
}
