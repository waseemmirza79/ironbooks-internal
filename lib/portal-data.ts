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

export function thisMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
  };
}

export function lastMonthRange(): { start: string; end: string } {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLast = new Date(now.getFullYear(), now.getMonth(), 0);
  return {
    start: lastMonth.toISOString().slice(0, 10),
    end: endOfLast.toISOString().slice(0, 10),
  };
}

export function ytdRange(): { start: string; end: string } {
  const now = new Date();
  return {
    start: `${now.getFullYear()}-01-01`,
    end: now.toISOString().slice(0, 10),
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
  currentMonthPL: ProfitLossData;
  lastMonthPL: ProfitLossData;
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
 * One-shot fetch for the portal Overview page. Everything runs in parallel
 * — we wait for the slowest call (usually the P&L report). Errors on
 * individual calls fail soft: each returns a defensible default so a
 * single QBO hiccup doesn't blank the whole landing page.
 */
export async function fetchOverview(
  realmId: string,
  accessToken: string
): Promise<OverviewData> {
  const thisMonth = thisMonthRange();
  const lastMonth = lastMonthRange();

  const [currentMonthPL, lastMonthPL, accounts, invoices, bills] = await Promise.all([
    safe(() => fetchProfitAndLoss(realmId, accessToken, thisMonth.start, thisMonth.end), {
      totalIncome: 0, totalExpenses: 0, netIncome: 0,
      mealsExpense: 0, mealsAccounts: [], lineItems: [],
    } as ProfitLossData),
    safe(() => fetchProfitAndLoss(realmId, accessToken, lastMonth.start, lastMonth.end), {
      totalIncome: 0, totalExpenses: 0, netIncome: 0,
      mealsExpense: 0, mealsAccounts: [], lineItems: [],
    } as ProfitLossData),
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
    asOfDate: thisMonth.end,
    currentMonthPL,
    lastMonthPL,
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
