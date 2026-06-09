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
 * The full calendar month immediately BEFORE the given month range.
 * `range.start` is expected to be the first of a month (YYYY-MM-01).
 * Used to step back when the "closed" month turns out to be empty.
 */
export function priorMonthOf(range: DateRange): DateRange {
  const d = new Date(range.start + "T00:00:00");
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const end = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
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

export interface ClosedPeriodWithRevenue {
  /** The raw closed-period result (before the empty-month step-back). */
  base: ClosedPeriodResult;
  /** The month we actually landed on — has revenue, or is the oldest we tried. */
  effectiveMonth: DateRange;
  /** Calendar month before effectiveMonth (for vs-prior comparisons). */
  priorMonth: DateRange;
  /** The P&L we already fetched for effectiveMonth — reuse, don't refetch. */
  effectivePL: ProfitLossData | null;
  /** How many months we stepped back from the resolved closed month (0 = none). */
  steppedBack: number;
}

/**
 * resolveClosedPeriod + a sanity check on revenue.
 *
 * The closed-period indicators can point at a month that hasn't actually
 * been reconciled yet (e.g. the calendar default lands on last month, but
 * the books for it are still being posted). Such a month typically reports
 * $0 income, which is confusing for clients. When that happens we step back
 * one calendar month at a time — up to `maxLookback` — until we find a month
 * with real revenue.
 *
 * Needs QBO creds because it fetches the P&L per candidate month. Returns the
 * P&L it landed on so callers don't double-fetch.
 */
export async function resolveClosedPeriodWithRevenue(
  service: any,
  clientLinkId: string,
  realmId: string,
  accessToken: string,
  maxLookback = 6
): Promise<ClosedPeriodWithRevenue> {
  const base = await resolveClosedPeriod(service, clientLinkId);

  let month = base.closedMonth;
  let pl = await safe(
    () => fetchProfitAndLoss(realmId, accessToken, month.start, month.end),
    null as ProfitLossData | null
  );
  let stepped = 0;

  // Step back while: the fetch succeeded AND it shows ~$0 income AND we
  // haven't hit the cap. A failed fetch (null) means we can't tell — stop
  // rather than loop on errors.
  while (pl !== null && Math.abs(pl.totalIncome) <= 0.5 && stepped < maxLookback) {
    month = priorMonthOf(month);
    pl = await safe(
      () => fetchProfitAndLoss(realmId, accessToken, month.start, month.end),
      null as ProfitLossData | null
    );
    stepped++;
  }

  return {
    base,
    effectiveMonth: month,
    priorMonth: priorMonthOf(month),
    effectivePL: pl,
    steppedBack: stepped,
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

// ─── A/R: RECENT PAYMENTS + DSO ─────────────────────────────────────────

export interface RecentPayment {
  payment_id: string;
  customer_id: string | null;
  customer_name: string | null;
  txn_date: string;       // payment date
  total_amount: number;
  /** Days from the linked invoice's date to this payment, weighted-avg ready. */
  days_to_pay: number | null;
  applied_amount: number; // amount applied to invoices on this payment
}

/**
 * Pull Payments from the last `lookbackDays` (default 180), enriched with
 * the days-to-pay derived from each payment's LinkedTxn → Invoice chain.
 *
 * Used by:
 *   - DSO calculation (weighted avg days_to_pay)
 *   - "Last paid" timestamp per customer on the A/R portal page
 *
 * Each Payment can apply to multiple invoices; days_to_pay is the
 * earliest-invoice-date diff (i.e. how long was the oldest applied
 * invoice outstanding when payment arrived).
 */
export async function fetchRecentPayments(
  realmId: string,
  accessToken: string,
  lookbackDays = 180
): Promise<RecentPayment[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const results: RecentPayment[] = [];
  // We'll need the invoice TxnDate to compute days_to_pay. Two-pass:
  //  1. Pull Payments in window (with their LinkedTxn → Invoice ids)
  //  2. Pull those invoices' TxnDates in a batch
  const payments: any[] = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const startPosition = page * pageSize + 1;
    const qbql = `SELECT * FROM Payment WHERE TxnDate >= '${since}' STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    let data: any;
    try {
      data = await qboQuery(realmId, accessToken, qbql);
    } catch (err: any) {
      console.warn("[portal-data] Recent Payment query failed:", err.message);
      break;
    }
    const rows: any[] = data?.QueryResponse?.Payment || [];
    payments.push(...rows);
    if (rows.length < pageSize) break;
    page++;
    if (page > 30) break;
  }

  const invoiceIds = new Set<string>();
  for (const p of payments) {
    for (const line of p.Line || []) {
      for (const lt of line.LinkedTxn || []) {
        if (lt.TxnType === "Invoice" && lt.TxnId) invoiceIds.add(String(lt.TxnId));
      }
    }
  }

  const invoiceDateById = new Map<string, string>();
  if (invoiceIds.size > 0) {
    const ids = Array.from(invoiceIds);
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const inClause = batch.map((id) => `'${id}'`).join(",");
      const qbql = `SELECT Id, TxnDate FROM Invoice WHERE Id IN (${inClause})`;
      try {
        const data: any = await qboQuery(realmId, accessToken, qbql);
        for (const inv of data?.QueryResponse?.Invoice || []) {
          invoiceDateById.set(String(inv.Id), inv.TxnDate);
        }
      } catch (err: any) {
        console.warn("[portal-data] Payment->Invoice lookup failed:", err.message);
      }
    }
  }

  for (const p of payments) {
    const linkedInvoiceIds: string[] = [];
    let appliedAmount = 0;
    for (const line of p.Line || []) {
      for (const lt of line.LinkedTxn || []) {
        if (lt.TxnType === "Invoice" && lt.TxnId) linkedInvoiceIds.push(String(lt.TxnId));
      }
      if (line.Amount != null) appliedAmount += Number(line.Amount);
    }
    // days_to_pay = max(0, payment date - earliest linked invoice date)
    let daysToPay: number | null = null;
    if (linkedInvoiceIds.length > 0) {
      const earliestInvoiceDate = linkedInvoiceIds
        .map((id) => invoiceDateById.get(id))
        .filter(Boolean)
        .sort()[0];
      if (earliestInvoiceDate) {
        const days = Math.floor(
          (new Date(p.TxnDate).getTime() - new Date(earliestInvoiceDate).getTime()) /
            86_400_000
        );
        daysToPay = Math.max(0, days);
      }
    }
    results.push({
      payment_id: String(p.Id),
      customer_id: p.CustomerRef?.value || null,
      customer_name: p.CustomerRef?.name || null,
      txn_date: p.TxnDate,
      total_amount: Number(p.TotalAmt || 0),
      days_to_pay: daysToPay,
      applied_amount: appliedAmount,
    });
  }

  return results;
}

/**
 * Days Sales Outstanding — weighted average days from invoice date to
 * payment date, across recent paid invoices. Weighted by payment amount
 * so a big slow-paying customer matters more than a small fast-paying one.
 *
 * Returns null if we don't have enough data (no paid invoices in window).
 */
export function computeDSO(payments: RecentPayment[]): number | null {
  let weightedDays = 0;
  let totalWeight = 0;
  for (const p of payments) {
    if (p.days_to_pay == null || p.applied_amount <= 0) continue;
    weightedDays += p.days_to_pay * p.applied_amount;
    totalWeight += p.applied_amount;
  }
  if (totalWeight === 0) return null;
  return Math.round(weightedDays / totalWeight);
}

/**
 * Build a per-customer summary blob for the A/R page: last payment date,
 * total paid in lookback window, contact info merged from QBO Customer.
 */
export interface ARCustomerSummary {
  customer_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  last_payment_date: string | null;
  last_payment_amount: number | null;
  total_paid_in_window: number;
}

export function summarizeCustomersForAR(
  customers: { id: string; display_name: string; primary_email: string | null; primary_phone?: string | null }[],
  payments: RecentPayment[]
): Map<string, ARCustomerSummary> {
  const byCustomer = new Map<string, ARCustomerSummary>();
  for (const c of customers) {
    byCustomer.set(c.id, {
      customer_id: c.id,
      display_name: c.display_name,
      email: c.primary_email,
      phone: c.primary_phone || null,
      last_payment_date: null,
      last_payment_amount: null,
      total_paid_in_window: 0,
    });
  }
  // Roll up payments
  for (const p of payments) {
    if (!p.customer_id) continue;
    if (!byCustomer.has(p.customer_id)) {
      // Customer might be inactive — still create an entry so the UI shows
      // last-payment-date even if contact info is missing
      byCustomer.set(p.customer_id, {
        customer_id: p.customer_id,
        display_name: p.customer_name || "(unknown customer)",
        email: null,
        phone: null,
        last_payment_date: null,
        last_payment_amount: null,
        total_paid_in_window: 0,
      });
    }
    const summary = byCustomer.get(p.customer_id)!;
    summary.total_paid_in_window += p.total_amount;
    if (!summary.last_payment_date || p.txn_date > summary.last_payment_date) {
      summary.last_payment_date = p.txn_date;
      summary.last_payment_amount = p.total_amount;
    }
  }
  return byCustomer;
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
