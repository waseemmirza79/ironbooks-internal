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

import { normalizeVendorForLookup, extractKnownVendorName } from "./vendor-knowledge";

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

// Bank-mechanism words that carry zero vendor-identifying information — a
// description built ONLY from these + numbers (Mike's example: "35 INTERAC
// PURCHASE 3199 3235") is noise, not a vendor, and must never become a
// one-off rule. Deliberately does NOT include ambiguous real words (city/
// province names, "PAYROLL", personal names) — those might be the only
// signal for a genuinely un-branded vendor and we'd rather over-include than
// silently drop a real recurring payee.
const BANK_NOISE_WORDS = new Set([
  "INTERAC", "ETRANSFER", "TRANSFER", "TFR", "EMT", "PURCHASE", "WITHDRAWAL",
  "WITHDRAWL", "DEPOSIT", "DEBIT", "CREDIT", "POS", "CONTACTLESS",
  "PREAUTHORIZED", "PREAUTH", "RECURRING", "PAYMENT", "PAYMENTS", "PAY",
  "BILL", "WEB", "ONLINE", "MOBILE", "CHECK", "CHEQUE", "ACH", "EFT", "EDI",
  "FIP", "FIS", "ATM", "REF", "TRACE", "AUTH", "NO", "ID", "DATE", "MEMO",
  "ORIG", "DESC", "SEC", "CCD", "TRN", "IND", "NAME", "NBR", "TO", "FROM",
  "THE", "AND", "OF", "CO", "INC", "LLC", "LTD", "CORP", "RECD", "RCVD",
  "CAD", "USD", "SENT", "RECEIVED", "SEND", "FEE",
]);

/** True when nothing but bank-mechanism words + numbers/masking remains —
 *  i.e. there is no vendor name here at all, only transaction plumbing. */
function isNoiseOnlyDescription(cleaned: string): boolean {
  // Split on any non-alphanumeric boundary (not just whitespace) so
  // "E-TRANSFER" tokenizes as "E" + "TRANSFER" — hyphens/slashes must not
  // hide a noise word from the stoplist.
  const tokens = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => {
    if (t.length <= 1) return true; // single-char fragments ("E" of E-Transfer)
    if (/^[\dxX*]+$/.test(t)) return true; // pure digits / masked ref numbers
    return BANK_NOISE_WORDS.has(t.toUpperCase());
  });
}

/**
 * Grouping key for a row: normalized vendor when real, else an attempt to
 * recognize a KNOWN brand embedded in the raw bank description (so "PETRO-
 * CANADA #1234 TORONTO ON" and "INTERAC PURCHASE - PETRO-CANADA" collapse
 * into ONE candidate keyed on the canonical vendor name instead of two
 * near-duplicate one-off rules), else a noise-stripped residual, else null
 * when the description is pure bank plumbing with no identifiable vendor
 * (Mike, 2026-07-14: "ignore things like 35 interac purchase 3199 3235").
 */
export function ruleGroupKey(
  row: Pick<RuleSourceRow, "vendor_name" | "vendor_pattern_normalized" | "description">
): { key: string; display: string } | null {
  const unknown = isUnknownVendor(row.vendor_name);
  const description = String(row.description || "").trim();
  if (unknown) {
    if (!description) return null;
    // Strip known bank-feed prefixes (INTERAC PURCHASE -, POS DEBIT, store
    // numbers) — the same normalization the daily-recon engine itself uses.
    const cleaned = normalizeVendorForLookup(description);
    // Known brand embedded anywhere in the (cleaned or raw) text → group by
    // the canonical name. Broadest possible net for the vendor we already
    // reviewed fleet-wide; every phrasing of the same brand merges here.
    const brand = extractKnownVendorName(cleaned || description);
    if (brand) return { key: brand.toUpperCase(), display: brand };
    if (isNoiseOnlyDescription(cleaned || description)) return null;
    const key = (cleaned || description).toUpperCase().replace(/\s+/g, " ");
    return { key, display: cleaned || description };
  }
  const key = row.vendor_pattern_normalized || row.vendor_name || "";
  if (!key || isUnknownVendor(key)) return null;
  return { key, display: row.vendor_name || key };
}

export interface ExportableRule {
  vendor_pattern: string;
  target_account_name: string;
}

/**
 * Retroactively broaden STORED bank rules for a QBO export — the same "one
 * broad rule per known brand" consolidation the candidate generator does
 * (e3d5974, Mike 2026-07-14), applied to rules that were created before that
 * update (one specific rule per raw descriptor). Non-destructive: transforms
 * the export list only, never the stored rows.
 *
 * A rule is broadened to `contains <brand>` ONLY when:
 *   1. its pattern resolves to a KNOWN vendor brand, AND
 *   2. that brand is a literal (case-insensitive) substring of the pattern —
 *      guarantees the broad rule matches a SUPERSET of what the specific rule
 *      matched (QBO "contains" is literal, so `Sherwin-Williams` must not
 *      replace `SHERWIN WILLIAMS` and silently stop matching), AND
 *   3. that brand maps to exactly ONE target account across this client's
 *      rules — a brand pointing at two accounts can't collapse to one broad
 *      rule without mis-routing, so those stay specific.
 * Everything else passes through unchanged. Duplicates (same pattern+target)
 * are de-duped. Returns the consolidated list + how many rows it collapsed.
 */
export function consolidateBankRulesForExport<T extends ExportableRule>(
  rules: T[]
): { rules: ExportableRule[]; collapsedFrom: number } {
  const clean = (s: string) => String(s || "").trim();
  const contains = (hay: string, needle: string) =>
    hay.toLowerCase().includes(needle.toLowerCase());

  // Pass 1 — resolve each rule's broadenable brand (substring-safe) + detect
  // brand→multiple-target conflicts.
  const brandOf = new Map<T, string | null>();
  const brandTargets = new Map<string, Set<string>>();
  for (const r of rules) {
    const pattern = clean(r.vendor_pattern);
    const brandRaw = extractKnownVendorName(pattern);
    const brand = brandRaw && contains(pattern, brandRaw) ? brandRaw : null;
    brandOf.set(r, brand);
    if (brand) {
      const key = brand.toLowerCase();
      if (!brandTargets.has(key)) brandTargets.set(key, new Set());
      brandTargets.get(key)!.add(clean(r.target_account_name).toLowerCase());
    }
  }
  const safeBrand = (brand: string) => (brandTargets.get(brand.toLowerCase())?.size ?? 0) === 1;

  // Pass 2 — emit, collapsing broadenable rules and de-duping pass-throughs.
  const out: ExportableRule[] = [];
  const seen = new Set<string>();
  let collapsedFrom = 0;
  for (const r of rules) {
    const brand = brandOf.get(r) || null;
    const target = clean(r.target_account_name);
    const useBroad = brand && safeBrand(brand);
    const pattern = useBroad ? brand! : clean(r.vendor_pattern);
    if (!pattern || !target) continue;
    const dedupeKey = `${pattern.toLowerCase()}|${target.toLowerCase()}`;
    if (seen.has(dedupeKey)) { collapsedFrom++; continue; }
    seen.add(dedupeKey);
    out.push({ vendor_pattern: pattern, target_account_name: target });
  }
  return { rules: out, collapsedFrom };
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
    // Sample the text that actually PROVES what this rule will match. For
    // unknown-vendor rows vendor_name is literally the string "Unknown
    // vendor" on every row — useless as a preview — so sample the raw bank
    // description instead (this is the "show the transactions that will go
    // into that rule" ask). Higher cap (was 3) for a real preview.
    const sample = isUnknownVendor(row.vendor_name)
      ? String(row.description || "").trim()
      : row.vendor_name || "";
    if (sample && g.samples.length < 6 && !g.samples.includes(sample)) {
      g.samples.push(sample);
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
