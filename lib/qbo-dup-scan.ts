import type { PLDetailRow } from "./qbo-reports";

/**
 * Duplicate-transaction detection over a P&L detail pull. Extracted from
 * app/api/admin/dup-scan/route.ts so the books-verification engine can run it
 * per client at close time. Pure — no QBO or DB access.
 *
 *   - exact_same_day : same account + payee + amount + date, 2+ rows (HIGH)
 *   - near_duplicate : same account + payee + amount within 3 days (MEDIUM)
 *   - duplicate_doc  : same doc # + type + amount posted 2+ times (HIGH)
 *
 * Recurring patterns (same key 4+ times in the month — weekly payroll, fuel)
 * are treated as legit and skipped.
 */
export type DupFinding = {
  kind: "exact_same_day" | "near_duplicate" | "duplicate_doc" | "reversal_pair";
  severity: "high" | "medium";
  section: string;
  account: string;
  name: string | null;
  amount: number;
  dates: string[];
  txn_types: string[];
  doc_numbers: (string | null)[];
  /** Distinct QBO transaction ids in the group — stable identity for the finding. */
  txn_ids: string[];
  count: number;
  note: string;
};

/** Same-originator ACH tell: "ORIG ID:XXXXXX2103" tokens in bank memos. */
function origIdOf(memo: string | null | undefined): string | null {
  const m = /ORIG\s*ID:\s*(\S+)/i.exec(memo || "");
  return m ? m[1].toUpperCase() : null;
}

/** Near-dups at/above this are HIGH severity (removable-track), not buried. */
export const NEAR_DUP_HIGH_FLOOR = 500;

export function findDuplicates(rows: PLDetailRow[], minAmount: number): DupFinding[] {
  const findings: DupFinding[] = [];
  // SIGN-AWARE key: a purchase and its refund share account+payee+|amount| but
  // are NOT duplicates of each other — grouping by abs() conflated them and
  // polluted the findings (Camellia: Sherwin/Lowe's store refunds). Same-sign
  // rows group for dup detection; opposite-sign pairs are detected separately
  // as reversal_pair below.
  const payeeOf = (r: PLDetailRow) => (r.name || r.memo.slice(0, 24)).toLowerCase().trim();
  const sig = (r: PLDetailRow) =>
    `${r.account}|${payeeOf(r)}|${Math.abs(r.amount).toFixed(2)}|${r.amount < 0 ? "-" : "+"}`;
  const eligible = rows.filter((r) => Math.abs(r.amount) >= minAmount && r.date);

  // Group by account+payee+amount+sign.
  const groups = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    const k = sig(r);
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }

  for (const [, g] of groups) {
    if (g.length < 2) continue;
    // 4+ hits of the same key in one month = recurring (weekly payroll/fuel) — legit.
    if (g.length >= 4) continue;
    const dates = [...new Set(g.map((r) => r.date))].sort();
    const sample = g[0];
    const spanDays =
      (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000;
    // Distinct txn ids required — the same transaction split across rows is not a dupe.
    const distinctIds = new Set(g.map((r) => r.txn_id || Math.random()));
    if (distinctIds.size < 2) continue;

    if (dates.length < g.length || spanDays === 0) {
      findings.push(mkFinding("exact_same_day", "high", sample, g,
        `${g.length}× identical posting on the same day — classic double entry (bank feed + manual, or double import)`));
    } else if (spanDays <= 3) {
      // Shared ACH originator across the pair = same biller pulled twice.
      const origIds = g.map((r) => origIdOf(r.memo)).filter(Boolean);
      const sameOrig = origIds.length === g.length && new Set(origIds).size === 1;
      // A large near-dup is a real-money double (Camellia: Lowe's $2,226.07
      // May 8 + May 9, identical ORIG ID — buried as medium/"possible" and
      // never surfaced). Promote to HIGH so it rides the removable track.
      const big = Math.abs(sample.amount) >= NEAR_DUP_HIGH_FLOOR;
      findings.push(mkFinding(
        "near_duplicate",
        big || sameOrig ? "high" : "medium",
        sample,
        g,
        `same payee & amount ${Math.round(spanDays)} day(s) apart${sameOrig ? " with the SAME bank originator (ORIG ID)" : ""} — ${big || sameOrig ? "likely" : "possible"} duplicate posting`
      ));
    }
  }

  // REVERSAL PAIRS — refund/credit netting against a purchase: same account +
  // payee + |amount|, opposite signs, within 30 days. Not duplicates (never
  // auto-removable) but surfaced so the bookkeeper confirms the refund is
  // placed/netted intentionally (Mike's Sherwin-refund-in-Paint&Materials ask).
  const byAbs = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    const k = `${r.account}|${payeeOf(r)}|${Math.abs(r.amount).toFixed(2)}`;
    (byAbs.get(k) || byAbs.set(k, []).get(k)!).push(r);
  }
  for (const [, g] of byAbs) {
    const pos = g.filter((r) => r.amount > 0);
    const neg = g.filter((r) => r.amount < 0);
    if (pos.length === 0 || neg.length === 0) continue;
    const pair = [pos[0], neg[0]];
    const spanDays = Math.abs(
      (new Date(pos[0].date).getTime() - new Date(neg[0].date).getTime()) / 86400000
    );
    if (spanDays > 30) continue;
    const distinctIds = new Set(pair.map((r) => r.txn_id).filter(Boolean));
    if (distinctIds.size < 2) continue;
    findings.push(mkFinding("reversal_pair", "medium", pos[0], pair,
      `refund/credit of ${Math.abs(neg[0].amount).toFixed(2)} nets against a matching charge ${Math.round(spanDays)} day(s) apart — verify the refund is intentional (not a duplicate order + refund, and placed in the right account)`));
  }

  // Duplicate document numbers (same doc # + type + amount, 2+ distinct txns).
  const byDoc = new Map<string, PLDetailRow[]>();
  for (const r of eligible) {
    if (!r.doc_number) continue;
    const k = `${r.txn_type}|${r.doc_number}|${Math.abs(r.amount).toFixed(2)}`;
    (byDoc.get(k) || byDoc.set(k, []).get(k)!).push(r);
  }
  for (const [, g] of byDoc) {
    const distinctIds = new Set(g.map((r) => r.txn_id));
    if (distinctIds.size < 2) continue;
    findings.push(mkFinding("duplicate_doc", "high", g[0], g,
      `doc #${g[0].doc_number} (${g[0].txn_type}) posted ${distinctIds.size}× — duplicate document`));
  }

  // High severity first, then by amount.
  findings.sort((a, b) => (a.severity === b.severity ? Math.abs(b.amount) - Math.abs(a.amount) : a.severity === "high" ? -1 : 1));
  return findings.slice(0, 50);
}

function mkFinding(kind: DupFinding["kind"], severity: DupFinding["severity"], sample: PLDetailRow, g: PLDetailRow[], note: string): DupFinding {
  return {
    kind, severity, note,
    section: sample.section, account: sample.account,
    name: sample.name || sample.memo.slice(0, 40) || null,
    amount: sample.amount,
    dates: [...new Set(g.map((r) => r.date))].sort(),
    txn_types: [...new Set(g.map((r) => r.txn_type))],
    doc_numbers: [...new Set(g.map((r) => r.doc_number))],
    txn_ids: [...new Set(g.map((r) => r.txn_id).filter(Boolean))].sort() as string[],
    count: g.length,
  };
}
