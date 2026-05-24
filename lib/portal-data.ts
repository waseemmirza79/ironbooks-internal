/**
 * Portal data fetchers — wrappers around the existing QBO helpers tuned
 * for the client-facing screens.
 *
 * Each function returns plain serializable data so it can be passed
 * server-component → client-component without serialization gymnastics.
 *
 * Cost / latency notes:
 *   - Overview page fetches in parallel: cash balances + current-month P&L
 *     + open invoices + open bills. ~3-5s on a typical QBO file. Cached
 *     loosely via the server component itself (one request = one batch).
 *   - Individual report pages re-fetch their own report on each render
 *     so date-range changes are honored.
 */
import { fetchProfitAndLoss, type ProfitLossData } from "./qbo-reports";
import { fetchAllAccounts, qboRateLimiter, type QBOAccount } from "./qbo";
import { fetchBalancesAsOf, fetchOpenInvoices, type OpenInvoice } from "./qbo-balance-sheet";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

async function qboQuery<T = any>(
  realmId: string,
  accessToken: string,
  qboQL: string
): Promise<T> {
  await qboRateLimiter.throttle(realmId);
  const url = `${QBO_BASE}/${realmId}/query?query=${encodeURIComponent(qboQL)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO query failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── DATE HELPERS ───────────────────────────────────────────────────────

export interface DateRange { start: string; end: string; label?: string; }

export function thisMonthRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
    label: "This month",
  };
}

export function lastMonthRange(): DateRange {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLast = new Date(now.getFullYear(), now.getMonth(), 0);
  return {
    start: lastMonth.toISOString().slice(0, 10),
    end: endOfLast.toISOString().slice(0, 10),
    label: "Last month",
  };
}

export function ytdRange(): DateRange {
  const now = new Date();
  return {
    start: `${now.getFullYear()}-01-01`,
    end: now.toISOString().slice(0, 10),
    label: "Year to date",
  };
}

export function lastYearRange(): DateRange {
  const now = new Date();
  const prevYear = now.getFullYear() - 1;
  return {
    start: `${prevYear}-01-01`,
    end: `${prevYear}-12-31`,
    label: `${prevYear}`,
  };
}

export function quarterRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
    label: "This quarter",
  };
}

/**
 * Resolve the most-recent fully-closed accounting period for a client.
 *
 * Priority order:
 *   1. Most recent reclass_job with month_closed_at — that job's
 *      date_range_end identifies the latest formally-closed month.
 *      Used by ongoing month-over-month bookkeeping.
 *   2. client_links.cleanup_range_end if cleanup_completed_at is set —
 *      the cleanup landed at this date. First MoM month hasn't been
 *      closed yet, so cleanup-range is the best fallback.
 *   3. Otherwise: end of last completed calendar month. Safe default
 *      that's almost always reasonable (you've usually closed last
 *      month by now even if the indicators aren't stamped).
 *
 * Returns the closed-through DATE *plus* a DateRange that spans the
 * closed calendar month (start..end of that month). Used by the portal
 * Overview and P&L pages to default to "real, reconciled" numbers
 * instead of "this month so far" garbage that confuses clients.
 */
export interface ClosedPeriodResult {
  /** ISO date 'YYYY-MM-DD' through which books are closed */
  closedThrough: string;
  /** DateRange covering the calendar month containing closedThrough */
  closedMonth: DateRange;
  /** DateRange for the month BEFORE the closed month (for vs-prior comparisons) */
  priorMonth: DateRange;
  /** Friendly label like "April 2026" for that month */
  closedMonthLabel: string;
  /** Source of truth — how we determined the closed-through date */
  source: "reclass_job_closed" | "cleanup_completed" | "calendar_default";
}

export async function resolveClosedPeriod(
  service: any,
  clientLinkId: string
): Promise<ClosedPeriodResult> {
  let closedThrough: string | null = null;
  let source: ClosedPeriodResult["source"] = "calendar_default";

  // 1. Most recent closed reclass job
  try {
    const { data: lastClosed } = await service
      .from("reclass_jobs")
      .select("date_range_end, month_closed_at")
      .eq("client_link_id", clientLinkId)
      .not("month_closed_at", "is", null)
      .order("date_range_end", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastClosed?.date_range_end) {
      closedThrough = lastClosed.date_range_end;
      source = "reclass_job_closed";
    }
  } catch { /* fall through */ }

  // 2. Cleanup completion date
  if (!closedThrough) {
    try {
      const { data: client } = await service
        .from("client_links")
        .select("cleanup_range_end, cleanup_completed_at")
        .eq("id", clientLinkId)
        .single();
      if (client?.cleanup_completed_at && client?.cleanup_range_end) {
        closedThrough = client.cleanup_range_end;
        source = "cleanup_completed";
      }
    } catch { /* fall through */ }
  }

  // 3. Calendar default — end of last completed calendar month
  if (!closedThrough) {
    const now = new Date();
    const endOfLast = new Date(now.getFullYear(), now.getMonth(), 0);
    closedThrough = endOfLast.toISOString().slice(0, 10);
  }

  // Build the month range containing closedThrough
  const closedDate = new Date(closedThrough + "T00:00:00");
  const closedMonthStart = new Date(closedDate.getFullYear(), closedDate.getMonth(), 1);
  const closedMonthEnd = new Date(closedDate.getFullYear(), closedDate.getMonth() + 1, 0);
  const closedMonth: DateRange = {
    start: closedMonthStart.toISOString().slice(0, 10),
    end: closedMonthEnd.toISOString().slice(0, 10),
    label: closedMonthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };

  // Prior month for comparison
  const priorMonthStart = new Date(closedDate.getFullYear(), closedDate.getMonth() - 1, 1);
  const priorMonthEnd = new Date(closedDate.getFullYear(), closedDate.getMonth(), 0);
  const priorMonth: DateRange = {
    start: priorMonthStart.toISOString().slice(0, 10),
    end: priorMonthEnd.toISOString().slice(0, 10),
    label: priorMonthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };

  return {
    closedThrough,
    closedMonth,
    priorMonth,
    closedMonthLabel: closedMonth.label!,
    source,
  };
}

// ─── OPEN BILLS (A/P) ───────────────────────────────────────────────────

export interface OpenBill {
  qbo_bill_id: string;
  doc_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  txn_date: string;
  due_date: string | null;
  total_amount: number;
  balance: number;
}

/**
 * Every Bill with balance > 0. The dual of fetchOpenInvoices (which lives
 * in qbo-balance-sheet.ts) — there's no A/P helper there yet so we add one
 * here. Same pagination + best-effort error handling.
 */
export async function fetchOpenBills(
  realmId: string,
  accessToken: string
): Promise<OpenBill[]> {
  const results: OpenBill[] = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const startPosition = page * pageSize + 1;
    const qbql = `SELECT * FROM Bill WHERE Balance > '0' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    let data: any;
    try {
      data = await qboQuery(realmId, accessToken, qbql);
    } catch (err: any) {
      console.warn("[portal-data] Bill query failed:", err.message);
      break;
    }
    const rows: any[] = data?.QueryResponse?.Bill || [];
    for (const b of rows) {
      results.push({
        qbo_bill_id: b.Id,
        doc_number: b.DocNumber || null,
        vendor_id: b.VendorRef?.value || null,
        vendor_name: b.VendorRef?.name || null,
        txn_date: b.TxnDate,
        due_date: b.DueDate || null,
        total_amount: Number(b.TotalAmt || 0),
        balance: Number(b.Balance || 0),
      });
    }
    if (rows.length < pageSize) break;
    page++;
  }
  return results;
}

// ─── AGING BUCKETS ──────────────────────────────────────────────────────

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface AgingSnapshot<T> {
  buckets: Record<AgingBucket, { count: number; total: number; items: T[] }>;
  totalCount: number;
  totalAmount: number;
}

export function ageInvoices(invoices: OpenInvoice[], asOf = new Date()): AgingSnapshot<OpenInvoice> {
  return ageItems(invoices, (i) => i.due_date || i.txn_date, (i) => i.balance, asOf);
}

export function ageBills(bills: OpenBill[], asOf = new Date()): AgingSnapshot<OpenBill> {
  return ageItems(bills, (b) => b.due_date || b.txn_date, (b) => b.balance, asOf);
}

function ageItems<T>(
  items: T[],
  dateOf: (t: T) => string,
  amountOf: (t: T) => number,
  asOf: Date
): AgingSnapshot<T> {
  const buckets: AgingSnapshot<T>["buckets"] = {
    current: { count: 0, total: 0, items: [] },
    "1-30": { count: 0, total: 0, items: [] },
    "31-60": { count: 0, total: 0, items: [] },
    "61-90": { count: 0, total: 0, items: [] },
    "90+": { count: 0, total: 0, items: [] },
  };
  let totalCount = 0;
  let totalAmount = 0;

  for (const item of items) {
    const dueDate = new Date(dateOf(item));
    const daysOverdue = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);
    const amt = amountOf(item);
    totalCount++;
    totalAmount += amt;

    const bucket: AgingBucket =
      daysOverdue <= 0 ? "current" :
      daysOverdue <= 30 ? "1-30" :
      daysOverdue <= 60 ? "31-60" :
      daysOverdue <= 90 ? "61-90" : "90+";
    buckets[bucket].count++;
    buckets[bucket].total += amt;
    buckets[bucket].items.push(item);
  }

  return { buckets, totalCount, totalAmount };
}

// ─── BANK BALANCES SUMMARY ──────────────────────────────────────────────

export interface BankSummary {
  totalCashOnHand: number;
  totalCreditCardDebt: number;
  accounts: { name: string; balance: number; type: "bank" | "credit_card" }[];
}

/**
 * Bank + credit card balances at "now". Uses fetchAllAccounts (cheap,
 * one QBO query) and filters by AccountType. Sum gives the cash-on-hand
 * tile on the overview page.
 */
export function summarizeBanks(accounts: QBOAccount[]): BankSummary {
  const bankAccts = accounts.filter((a) => a.Active !== false && a.AccountType === "Bank");
  const ccAccts = accounts.filter((a) => a.Active !== false && a.AccountType === "Credit Card");

  const totalCashOnHand = bankAccts.reduce((s, a) => s + (a.CurrentBalance || 0), 0);
  const totalCreditCardDebt = ccAccts.reduce((s, a) => s + Math.abs(a.CurrentBalance || 0), 0);

  return {
    totalCashOnHand,
    totalCreditCardDebt,
    accounts: [
      ...bankAccts.map((a) => ({
        name: a.Name,
        balance: a.CurrentBalance || 0,
        type: "bank" as const,
      })),
      ...ccAccts.map((a) => ({
        name: a.Name,
        balance: a.CurrentBalance || 0,
        type: "credit_card" as const,
      })),
    ],
  };
}

// ─── OVERVIEW AGGREGATOR ────────────────────────────────────────────────

export interface OverviewData {
  asOfDate: string;
  primaryMonth: DateRange;
  comparisonMonth: DateRange;
  primaryPL: ProfitLossData;
  comparisonPL: ProfitLossData;
  banks: BankSummary;
  openARTotal: number;
  openARCount: number;
  openARArr: OpenInvoice[];
  openAPTotal: number;
  openAPCount: number;
  openAPArr: OpenBill[];
  overdueARTotal: number;
  overdueARCount: number;
}

/**
 * One-shot fetch for the portal Overview page. Caller passes the date
 * ranges to use for the primary period (KPI tiles, narrative) and the
 * comparison period (vs-last-month deltas). The portal Overview page
 * passes the closed-period ranges; other callers can pass whatever.
 */
export async function fetchOverview(
  realmId: string,
  accessToken: string,
  primaryMonth: DateRange,
  comparisonMonth: DateRange
): Promise<OverviewData> {
  const emptyPL: ProfitLossData = {
    totalIncome: 0, totalExpenses: 0, netIncome: 0,
    mealsExpense: 0, mealsAccounts: [], lineItems: [],
  };

  const [primaryPL, comparisonPL, accounts, invoices, bills] = await Promise.all([
    safe(() => fetchProfitAndLoss(realmId, accessToken, primaryMonth.start, primaryMonth.end), emptyPL),
    safe(() => fetchProfitAndLoss(realmId, accessToken, comparisonMonth.start, comparisonMonth.end), emptyPL),
    safe(() => fetchAllAccounts(realmId, accessToken), [] as QBOAccount[]),
    safe(() => fetchOpenInvoices(realmId, accessToken), [] as OpenInvoice[]),
    safe(() => fetchOpenBills(realmId, accessToken), [] as OpenBill[]),
  ]);

  const banks = summarizeBanks(accounts);
  const arAging = ageInvoices(invoices);
  const overdueAR =
    arAging.buckets["1-30"].total +
    arAging.buckets["31-60"].total +
    arAging.buckets["61-90"].total +
    arAging.buckets["90+"].total;
  const overdueCount =
    arAging.buckets["1-30"].count +
    arAging.buckets["31-60"].count +
    arAging.buckets["61-90"].count +
    arAging.buckets["90+"].count;

  return {
    asOfDate: primaryMonth.end,
    primaryMonth,
    comparisonMonth,
    primaryPL,
    comparisonPL,
    banks,
    openARTotal: arAging.totalAmount,
    openARCount: arAging.totalCount,
    openARArr: invoices,
    openAPTotal: bills.reduce((s, b) => s + b.balance, 0),
    openAPCount: bills.length,
    openAPArr: bills,
    overdueARTotal: overdueAR,
    overdueARCount: overdueCount,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    console.warn("[portal-data] fetch failed (using fallback):", err?.message);
    return fallback;
  }
}

// ─── AS-OF BALANCE SHEET ────────────────────────────────────────────────

export interface BalanceSheetSummary {
  asOfDate: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Account-id → balance for the BS report at the requested date */
  balances: Map<string, number>;
  /** Active accounts metadata */
  accounts: QBOAccount[];
}

export async function fetchBalanceSheetSummary(
  realmId: string,
  accessToken: string,
  asOfDate?: string
): Promise<BalanceSheetSummary> {
  const date = asOfDate || new Date().toISOString().slice(0, 10);
  const [balances, accounts] = await Promise.all([
    safe(() => fetchBalancesAsOf(realmId, accessToken, date), new Map<string, number>()),
    safe(() => fetchAllAccounts(realmId, accessToken), [] as QBOAccount[]),
  ]);

  const activeAccounts = accounts.filter((a) => a.Active !== false);

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;

  for (const a of activeAccounts) {
    const bal = balances.get(a.Id) ?? 0;
    if (a.Classification === "Asset") totalAssets += bal;
    else if (a.Classification === "Liability") totalLiabilities += bal;
    else if (a.Classification === "Equity") totalEquity += bal;
  }

  return {
    asOfDate: date,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balances,
    accounts: activeAccounts,
  };
}
