/**
 * CRM invoice revenue — fleet detection + deposit↔invoice pairing.
 *
 * The Dominion Painters pattern: a field CRM (Jobber / DripJobs / Housecall)
 * pushes INVOICES into QBO that recognize as income on the cash-basis P&L,
 * while the bank DEPOSIT that pays each job is separately categorized to a
 * revenue account — the same job counted twice. (Jennifer De Wit: $1,002.58
 * invoice in Billable Expense Income + $1,132.91 deposit in Service Revenue
 * = invoice net × 1.13 HST.)
 *
 * This module finds that pattern from cash-basis P&L detail alone:
 *   - the INVOICE leg: invoice-recognized income, grouped per invoice txn
 *   - the DEPOSIT leg: Deposit transactions posting into income accounts
 *   - PAIRS: deposit ≈ invoice total × tax factor (exact / +5% GST / +13% HST
 *     / generic tax-inclusive), same customer, close in time
 *
 * Clients with no invoices at all produce an empty invoice leg and are never
 * flagged (deposits are their only way to record a sale — correct books).
 * Invoice-only clients (payments properly matched, no deposits in income) are
 * also never flagged.
 *
 * Pure + dependency-free (fixture-tested). Consumed by the fleet sweep
 * (/api/admin/crm-invoice-sweep), the remediation screen, and the reclass
 * duplicate-revenue warning.
 */

import type { PLDetailRow } from "./qbo-reports";

export interface CrmInvoiceTxn {
  txn_id: string;
  doc_number: string | null;
  customer: string | null;
  date: string; // earliest line date
  total: number; // sum of its income lines (net of tax — QBO reports net)
  accounts: string[];
}

export interface IncomeDepositRow {
  txn_id: string;
  date: string;
  account: string;
  customer: string | null;
  amount: number;
}

export interface DepositInvoicePair {
  invoice: CrmInvoiceTxn;
  deposit: IncomeDepositRow;
  /** deposit ÷ invoice total, rounded to 4dp. */
  factor: number;
  /** Which tax interpretation matched. */
  taxLabel: "exact" | "+5% GST" | "+13% HST" | "tax-inclusive (~)";
  sameCustomer: boolean;
  daysApart: number | null;
  confidence: "high" | "medium";
}

export interface CrmInvoiceRevenueReport {
  invoiceTxnCount: number;
  invoiceIncomeTotal: number;
  invoiceByAccount: Record<string, number>;
  depositCount: number;
  depositIncomeTotal: number;
  pairs: DepositInvoicePair[];
  pairedInvoiceTotal: number;
  pairedDepositTotal: number;
  /** Customers appearing on BOTH legs (invoice + income deposit). */
  customersBothLegs: string[];
  flagged: boolean;
  reason: string;
}

/** Materiality floor for the deposit leg. */
export const CRM_DEPOSIT_FLOOR = 500;
/** Minimum invoice presence for "this book has CRM invoices". */
export const CRM_INVOICE_MIN_COUNT = 3;

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

// Income legs are identified by TRANSACTION TYPE, not the P&L section. On the
// ProfitAndLossDetail report the top section is the combined "Ordinary
// Income/Expenses" wrapper (contains both "income" and "expense"), so a
// section regex rejects every row — the bug that returned 0 invoices/0
// deposits for Dominion despite 74 invoice + 19 deposit rows being present.
// Invoice rows credit income (A/R is off the P&L); deposit rows on a P&L
// detail hit income accounts by construction. An optional incomeAccounts set
// lets a caller further restrict the deposit leg (belt-and-suspenders against
// a rare deposit into a contra-expense).
const isInvoice = (t: string | null | undefined) => /invoice/i.test(t || "");
const isDeposit = (t: string | null | undefined) => /^deposit$/i.test((t || "").trim());

function normCustomer(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Income-account names from a summary P&L (fetchProfitAndLoss), used to
 * restrict the deposit leg to ACTUAL income. Critical: without this the
 * detector counts every Deposit-type row — including deposits that only clear
 * Undeposited Funds and their processing-fee lines (Clean Your Carpets /
 * Housecall Pro) — and false-flags an invoice-driven book whose deposits
 * aren't revenue at all. The summary's line-item `group` is the clean
 * "Income" label (the DETAIL report's section is the useless combined
 * "Ordinary Income/Expenses" wrapper).
 */
export function incomeAccountNamesFromSummary(
  pl: { lineItems?: { label: string; group: string }[] } | null | undefined
): Set<string> {
  const s = new Set<string>();
  for (const li of pl?.lineItems || []) {
    const g = (li.group || "").toLowerCase();
    if (/income|revenue|sales/.test(g) && !/cost of goods|expense/.test(g)) s.add(li.label);
  }
  return s;
}

/** Classify deposit÷invoice ratio into a tax interpretation, or null. */
export function taxFactorLabel(factor: number): DepositInvoicePair["taxLabel"] | null {
  if (factor >= 0.995 && factor <= 1.005) return "exact";
  if (factor >= 1.045 && factor <= 1.055) return "+5% GST";
  if (factor >= 1.115 && factor <= 1.145) return "+13% HST";
  if (factor >= 0.98 && factor <= 1.2) return "tax-inclusive (~)";
  return null;
}

/**
 * Analyze one client's cash-basis P&L detail for the CRM invoice/deposit
 * double-count. Pairing is greedy 1:1 — largest invoices first, each taking
 * its best unused deposit (customer match, then tightest tax factor, then
 * nearest date).
 */
export function analyzeCrmInvoiceRevenue(
  plDetail: PLDetailRow[] | null | undefined,
  incomeAccounts?: Set<string> | null
): CrmInvoiceRevenueReport {
  const empty: CrmInvoiceRevenueReport = {
    invoiceTxnCount: 0,
    invoiceIncomeTotal: 0,
    invoiceByAccount: {},
    depositCount: 0,
    depositIncomeTotal: 0,
    pairs: [],
    pairedInvoiceTotal: 0,
    pairedDepositTotal: 0,
    customersBothLegs: [],
    flagged: false,
    reason: "No P&L detail",
  };
  if (!plDetail || plDetail.length === 0) return empty;

  // ── Legs ──
  const invoiceByTxn = new Map<string, CrmInvoiceTxn>();
  const invoiceByAccount: Record<string, number> = {};
  const deposits: IncomeDepositRow[] = [];

  const incomeAcctLc = incomeAccounts
    ? new Set([...incomeAccounts].map((a) => (a || "").toLowerCase()))
    : null;

  for (const row of plDetail) {
    const amount = Number(row.amount) || 0;

    if (isInvoice(row.txn_type)) {
      const key = row.txn_id || `${row.doc_number}-${row.date}`;
      const inv =
        invoiceByTxn.get(key) ||
        ({
          txn_id: row.txn_id,
          doc_number: row.doc_number ?? null,
          customer: row.name ?? null,
          date: row.date,
          total: 0,
          accounts: [],
        } as CrmInvoiceTxn);
      inv.total = r2(inv.total + amount);
      if (row.date < inv.date) inv.date = row.date;
      if (!inv.customer && row.name) inv.customer = row.name;
      const acct = row.account || "(no account)";
      if (!inv.accounts.includes(acct)) inv.accounts.push(acct);
      invoiceByAccount[acct] = r2((invoiceByAccount[acct] || 0) + amount);
      invoiceByTxn.set(key, inv);
    } else if (isDeposit(row.txn_type)) {
      // Restrict to income accounts only when the caller supplied the set.
      if (incomeAcctLc && !incomeAcctLc.has((row.account || "").toLowerCase())) continue;
      deposits.push({
        txn_id: row.txn_id,
        date: row.date,
        account: row.account || "(no account)",
        customer: row.name ?? null,
        amount: r2(amount),
      });
    }
  }

  const invoices = [...invoiceByTxn.values()].filter((i) => i.total > 0);
  const invoiceIncomeTotal = r2(invoices.reduce((s, i) => s + i.total, 0));
  const depositIncomeTotal = r2(deposits.reduce((s, d) => s + d.amount, 0));

  // ── Customer overlap ──
  const invCustomers = new Set(invoices.map((i) => normCustomer(i.customer)).filter(Boolean));
  const depCustomers = new Set(deposits.map((d) => normCustomer(d.customer)).filter(Boolean));
  const customersBothLegs = [...invCustomers].filter((c) => depCustomers.has(c));

  // ── Greedy 1:1 pairing ──
  const usedDeposits = new Set<number>();
  const pairs: DepositInvoicePair[] = [];
  const sortedInvoices = [...invoices].sort((a, b) => b.total - a.total);

  for (const inv of sortedInvoices) {
    if (inv.total <= 0) continue;
    let best: { idx: number; pair: DepositInvoicePair; score: number } | null = null;

    for (let i = 0; i < deposits.length; i++) {
      if (usedDeposits.has(i)) continue;
      const dep = deposits[i];
      if (dep.amount <= 0) continue;
      const factor = dep.amount / inv.total;
      const taxLabel = taxFactorLabel(factor);
      if (!taxLabel) continue;

      const sameCustomer =
        !!normCustomer(inv.customer) && normCustomer(inv.customer) === normCustomer(dep.customer);
      const days = daysBetween(inv.date, dep.date);
      // Deposits normally trail the invoice; allow a small lead (CRM timing).
      if (days !== null && (days < -14 || days > 120)) continue;

      // Loose factor needs the customer to corroborate.
      if (taxLabel === "tax-inclusive (~)" && !sameCustomer) continue;

      const tight = taxLabel !== "tax-inclusive (~)";
      const confidence: DepositInvoicePair["confidence"] =
        sameCustomer && tight ? "high" : "medium";
      // Without a customer match, only tight factors within 45 days qualify.
      if (!sameCustomer && !(tight && days !== null && Math.abs(days) <= 45)) continue;

      const score =
        (sameCustomer ? 100 : 0) +
        (tight ? 50 : 0) -
        Math.abs(1.13 - factor) * 10 -
        (days !== null ? Math.abs(days) * 0.1 : 5);

      if (!best || score > best.score) {
        best = {
          idx: i,
          score,
          pair: {
            invoice: inv,
            deposit: dep,
            factor: Math.round(factor * 10000) / 10000,
            taxLabel,
            sameCustomer,
            daysApart: days,
            confidence,
          },
        };
      }
    }

    if (best) {
      usedDeposits.add(best.idx);
      pairs.push(best.pair);
    }
  }

  const pairedInvoiceTotal = r2(pairs.reduce((s, p) => s + p.invoice.total, 0));
  const pairedDepositTotal = r2(pairs.reduce((s, p) => s + p.deposit.amount, 0));

  // ── Flag heuristic ── STRUCTURAL: the double-count is a material invoice
  // leg AND a material deposit-into-income leg both present. Pairing is
  // supporting evidence, NOT a gate — real books use batch payouts and
  // deposits with no customer name that don't pair 1:1, so requiring pairs
  // would miss obvious double-counts (Dominion: $48.9K invoices + $45.5K
  // deposits, few clean pairs).
  const hasInvoiceLeg = invoices.length >= CRM_INVOICE_MIN_COUNT && invoiceIncomeTotal >= CRM_DEPOSIT_FLOOR;
  const hasDepositLeg = depositIncomeTotal >= CRM_DEPOSIT_FLOOR;
  const flagged = hasInvoiceLeg && hasDepositLeg;

  const fmt = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString()}`;
  let reason: string;
  if (invoices.length === 0) {
    reason = "No invoice-recognized income — deposits are this client's only revenue entry (correct for a no-invoice book).";
  } else if (deposits.length === 0) {
    reason = "Invoices present but no deposits posted into income — payments look properly matched.";
  } else if (flagged) {
    const pairNote = pairs.length > 0 ? ` (${pairs.length} clean deposit↔invoice matches, ${fmt(pairedDepositTotal)})` : " (no clean 1:1 matches — likely batch payouts)";
    reason = `${invoices.length} invoices recognizing ${fmt(invoiceIncomeTotal)} AND ${deposits.length} deposits totaling ${fmt(depositIncomeTotal)} in income — the same revenue counted twice${pairNote}. Recognize deposits only.`;
  } else {
    reason = `Both legs present but below the materiality floor (invoices ${fmt(invoiceIncomeTotal)}, deposits ${fmt(depositIncomeTotal)}) — review manually.`;
  }

  return {
    invoiceTxnCount: invoices.length,
    invoiceIncomeTotal,
    invoiceByAccount,
    depositCount: deposits.length,
    depositIncomeTotal,
    pairs,
    pairedInvoiceTotal,
    pairedDepositTotal,
    customersBothLegs,
    flagged,
    reason,
  };
}
