/**
 * CPA round-trip — the missing loop between SNAP's books and the client's
 * accountant:
 *
 *   1. TRIAL BALANCE DIFF — paste the CPA's closing TB, diff it against the
 *      live QBO trial balance as of the same date, account by account. "For
 *      our Corps — closing TB does not agree to CPA office" becomes a
 *      concrete per-account variance list instead of a vibe.
 *   2. AJE ENTRY — paste the CPA's adjusting journal entries, preview them
 *      resolved against the client's chart, post the balanced ones to QBO.
 *   3. FILED-AMOUNT TIE-OUT — record what was actually filed (GST/HST,
 *      source deductions, corp tax) and compare to the ledger liability.
 *
 * This module is the PURE half (parsers + matchers + diff) so the math is
 * fixture-testable; QBO reads/writes live in the API routes.
 */

// ─── shared parsing helpers ─────────────────────────────────────────────────

/** Tolerant CSV/TSV split honoring quoted fields. */
export function splitRows(input: string): string[][] {
  const text = (input || "").replace(/^﻿/, "");
  const delim = text.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      field += ch; continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { cur.push(field.trim()); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field.trim()); field = "";
      if (cur.some((c) => c.length > 0)) rows.push(cur);
      cur = [];
      continue;
    }
    field += ch;
  }
  if (field || cur.length) { cur.push(field.trim()); if (cur.some((c) => c.length > 0)) rows.push(cur); }
  return rows;
}

export function parseMoney(val: string | undefined | null): number | null {
  if (val == null) return null;
  let s = String(val).replace(/[$,\s]/g, "");
  if (!s || s === "-" || s === "–") return null;
  // Accounting negatives: (1,234.56)
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -n : n;
}

/** Normalize an account label for matching: lowercase, strip a leading
 *  account number ("1010 - " / "1010 · "), punctuation, and whitespace runs. */
export function normAccount(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/^\s*\d{3,6}\s*[-–·:.]?\s*/, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const findIdx = (headers: string[], ...names: string[]) => {
  const H = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  for (const n of names) {
    const idx = H.findIndex((h) => h === n || h.includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
};

// ─── 1. Trial balance ───────────────────────────────────────────────────────

export interface TbRow {
  account: string;
  /** Signed: debits positive, credits negative — the TB convention. */
  amount: number;
}

/**
 * Parse a CPA trial balance paste. Accepts:
 *   account, debit, credit          (classic two-column TB)
 *   account, balance|amount         (signed single column)
 * Skips header/total rows; ignores unparseable lines rather than failing.
 */
export function parseTrialBalance(text: string): { rows: TbRow[]; skipped: number } {
  const raw = splitRows(text);
  if (raw.length === 0) return { rows: [], skipped: 0 };

  // Header detection: first row with no parseable number in cols 1+.
  const first = raw[0];
  const hasHeader = first.slice(1).every((c) => parseMoney(c) === null);
  const headers = hasHeader ? first : [];
  const body = hasHeader ? raw.slice(1) : raw;

  let acctIdx = 0, debitIdx = -1, creditIdx = -1, balIdx = -1;
  if (headers.length) {
    const a = findIdx(headers, "account", "name", "description");
    if (a >= 0) acctIdx = a;
    debitIdx = findIdx(headers, "debit", "dr");
    creditIdx = findIdx(headers, "credit", "cr");
    balIdx = findIdx(headers, "balance", "amount", "total");
  } else if (body[0]) {
    // No header: account, then 1 or 2 numeric columns.
    if (body[0].length >= 3) { debitIdx = 1; creditIdx = 2; }
    else balIdx = 1;
  }
  if (debitIdx < 0 && creditIdx < 0 && balIdx < 0) { debitIdx = 1; creditIdx = 2; }

  const rows: TbRow[] = [];
  let skipped = 0;
  for (const r of body) {
    const account = (r[acctIdx] || "").trim();
    if (!account || /^total\b|^grand total/i.test(account)) { skipped++; continue; }
    let amount: number | null = null;
    if (debitIdx >= 0 || creditIdx >= 0) {
      const d = parseMoney(r[debitIdx]) || 0;
      const c = parseMoney(r[creditIdx]) || 0;
      if (d === 0 && c === 0 && parseMoney(r[balIdx]) === null) { skipped++; continue; }
      amount = Math.round((d - c) * 100) / 100;
    }
    if (amount === null && balIdx >= 0) amount = parseMoney(r[balIdx]);
    if (amount === null) { skipped++; continue; }
    rows.push({ account, amount });
  }
  return { rows, skipped };
}

export interface TbDiffRow {
  cpa_account: string | null;
  qbo_account: string | null;
  cpa_amount: number | null;
  qbo_amount: number | null;
  diff: number; // qbo − cpa (0 for matched-equal)
  status: "matched" | "variance" | "cpa_only" | "qbo_only";
}

/**
 * Diff a CPA TB against the QBO TB. Matching: exact normalized name, then
 * unique contains-match. Amounts within 1¢ = matched; else variance.
 */
export function diffTrialBalances(cpa: TbRow[], qbo: TbRow[]): {
  rows: TbDiffRow[];
  summary: { matched: number; variance: number; cpa_only: number; qbo_only: number; total_abs_diff: number };
} {
  const qboByNorm = new Map<string, TbRow[]>();
  for (const q of qbo) {
    const k = normAccount(q.account);
    if (!qboByNorm.has(k)) qboByNorm.set(k, []);
    qboByNorm.get(k)!.push(q);
  }
  const claimed = new Set<TbRow>();
  const rows: TbDiffRow[] = [];

  const takeMatch = (cpaRow: TbRow): TbRow | null => {
    const k = normAccount(cpaRow.account);
    const exact = (qboByNorm.get(k) || []).filter((q) => !claimed.has(q));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      // Same normalized name several times — take closest amount.
      return exact.sort(
        (a, b) => Math.abs(a.amount - cpaRow.amount) - Math.abs(b.amount - cpaRow.amount)
      )[0];
    }
    // Unique contains-match either direction.
    const contains = qbo.filter((q) => {
      if (claimed.has(q)) return false;
      const qk = normAccount(q.account);
      return qk.length > 3 && k.length > 3 && (qk.includes(k) || k.includes(qk));
    });
    return contains.length === 1 ? contains[0] : null;
  };

  for (const c of cpa) {
    const m = takeMatch(c);
    if (m) {
      claimed.add(m);
      const diff = Math.round((m.amount - c.amount) * 100) / 100;
      rows.push({
        cpa_account: c.account,
        qbo_account: m.account,
        cpa_amount: c.amount,
        qbo_amount: m.amount,
        diff,
        status: Math.abs(diff) <= 0.01 ? "matched" : "variance",
      });
    } else {
      rows.push({
        cpa_account: c.account,
        qbo_account: null,
        cpa_amount: c.amount,
        qbo_amount: null,
        diff: Math.round(-c.amount * 100) / 100,
        status: "cpa_only",
      });
    }
  }
  for (const q of qbo) {
    if (claimed.has(q) || Math.abs(q.amount) < 0.01) continue;
    rows.push({
      cpa_account: null,
      qbo_account: q.account,
      cpa_amount: null,
      qbo_amount: q.amount,
      diff: Math.round(q.amount * 100) / 100,
      status: "qbo_only",
    });
  }

  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const summary = {
    matched: rows.filter((r) => r.status === "matched").length,
    variance: rows.filter((r) => r.status === "variance").length,
    cpa_only: rows.filter((r) => r.status === "cpa_only").length,
    qbo_only: rows.filter((r) => r.status === "qbo_only").length,
    total_abs_diff: Math.round(rows.reduce((s, r) => s + Math.abs(r.diff), 0) * 100) / 100,
  };
  return { rows, summary };
}

// ─── 2. CPA AJEs ────────────────────────────────────────────────────────────

export interface AjeLine {
  account: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface AjeEntry {
  key: string; // entry number or synthesized group key
  txn_date: string | null;
  memo: string | null;
  lines: AjeLine[];
  balanced: boolean;
}

/**
 * Parse a pasted AJE export. Expected columns (fuzzy): [entry/je#], date,
 * account, debit, credit, [memo]. Lines group by entry number when present,
 * else by date+memo. Every entry is checked debits==credits (±2¢).
 */
export function parseAjes(text: string): { entries: AjeEntry[]; skipped: number } {
  const raw = splitRows(text);
  if (raw.length === 0) return { entries: [], skipped: 0 };

  const first = raw[0];
  const hasHeader = first.every((c) => parseMoney(c) === null || /^\d{1,3}$/.test(c) === false) &&
    /account|debit|credit|date/i.test(first.join(" "));
  const headers = hasHeader ? first : [];
  const body = hasHeader ? raw.slice(1) : raw;

  let noIdx = -1, dateIdx = -1, acctIdx = -1, debitIdx = -1, creditIdx = -1, memoIdx = -1;
  if (headers.length) {
    noIdx = findIdx(headers, "entry", "je", "no", "num");
    dateIdx = findIdx(headers, "date");
    acctIdx = findIdx(headers, "account", "name");
    debitIdx = findIdx(headers, "debit", "dr");
    creditIdx = findIdx(headers, "credit", "cr");
    memoIdx = findIdx(headers, "memo", "description", "note");
  } else {
    // Positional fallback: date, account, debit, credit, memo?
    dateIdx = 0; acctIdx = 1; debitIdx = 2; creditIdx = 3; memoIdx = 4;
  }
  if (acctIdx < 0 || (debitIdx < 0 && creditIdx < 0)) {
    return { entries: [], skipped: body.length };
  }

  const groups = new Map<string, { txn_date: string | null; memo: string | null; lines: AjeLine[] }>();
  let skipped = 0;
  let lastKey: string | null = null;

  const normDate = (v: string | undefined): string | null => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  for (const r of body) {
    const account = (r[acctIdx] || "").trim();
    const debit = parseMoney(r[debitIdx]) || 0;
    const credit = parseMoney(r[creditIdx]) || 0;
    if (!account || (debit === 0 && credit === 0)) { skipped++; continue; }
    const date = normDate(dateIdx >= 0 ? r[dateIdx] : undefined);
    const memo = memoIdx >= 0 ? (r[memoIdx] || "").trim() || null : null;
    const no = noIdx >= 0 ? (r[noIdx] || "").trim() : "";
    // Group: explicit entry #, else date+memo, else continue the last group.
    const key: string = no || (date || memo ? `${date || ""}|${memo || ""}` : lastKey || "entry-1");
    lastKey = key;
    if (!groups.has(key)) groups.set(key, { txn_date: date, memo, lines: [] });
    const g = groups.get(key)!;
    if (!g.txn_date && date) g.txn_date = date;
    if (!g.memo && memo) g.memo = memo;
    g.lines.push({ account, debit, credit, memo });
  }

  const entries: AjeEntry[] = [...groups.entries()].map(([key, g]) => {
    const d = g.lines.reduce((s, l) => s + l.debit, 0);
    const c = g.lines.reduce((s, l) => s + l.credit, 0);
    return { key, txn_date: g.txn_date, memo: g.memo, lines: g.lines, balanced: Math.abs(d - c) <= 0.02 };
  });
  return { entries, skipped };
}

// ─── 3. Filed-amount tie-out ────────────────────────────────────────────────

export type FilingType = "gst_hst" | "source_deductions" | "corp_tax";

export const FILING_LABELS: Record<FilingType, string> = {
  gst_hst: "GST/HST",
  source_deductions: "Source deductions",
  corp_tax: "Corporate tax",
};

/** Ledger accounts whose balance the filing ties out against. */
export const FILING_ACCOUNT_RES: Record<FilingType, RegExp> = {
  gst_hst: /gst|hst|sales tax payable/i,
  source_deductions: /source deduction|payroll liabilit|receiver general|payroll tax payable|cpp|employment insurance/i,
  corp_tax: /corporate tax|income tax payable|corp tax|taxes payable/i,
};

export function tieOutFiling(
  filedAmount: number,
  ledgerAccounts: Array<{ name: string; balance: number }>,
  type: FilingType
): { ledger_total: number; variance: number; accounts: Array<{ name: string; balance: number }> } {
  const hits = ledgerAccounts.filter((a) => FILING_ACCOUNT_RES[type].test(a.name));
  const ledger = Math.round(hits.reduce((s, a) => s + a.balance, 0) * 100) / 100;
  return {
    ledger_total: ledger,
    variance: Math.round((ledger - filedAmount) * 100) / 100,
    accounts: hits,
  };
}
