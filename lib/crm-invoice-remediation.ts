/**
 * CRM invoice remediation — the QBO WRITE plan for a cash-deposits-only client.
 *
 * Recommended fix (Mike, 2026-07-15): for each CRM invoice recognized as
 * revenue, VOID it (keeps the doc + number, zeroes the income — audit trail
 * intact; never delete) after VOIDING its linked payment first. The bank
 * deposit that's the real cash is LEFT UNTOUCHED. Same primitive path the UF
 * Audit already uses (lib/qbo.ts voidPayment → voidInvoice).
 *
 * SAFETY is the whole game — voiding a payment removes cash, so we only ever
 * auto-target the PHANTOM payment: one that sits in Undeposited Funds and was
 * never rolled into a real bank Deposit (because the real money came in as the
 * separate income deposit). A payment that hit a bank account, or that a
 * Deposit references, is REAL cash — flagged "review", never auto-selected.
 *
 * This module is the pure planner (fixture-tested). The endpoints fetch the
 * QBO entities and feed them here; the apply route re-validates server-side
 * before any write and defaults to dry-run.
 */

export interface RemediationPayment {
  id: string;
  amount: number;
  /** Payment.DepositToAccountRef.name — where the payment landed. NULL usually
   *  means QBO's default (Undeposited Funds) — surfaced to the reviewer, but
   *  never auto-trusted for the phantom classification. */
  depositAccount: string | null;
  /** True if a Deposit references this payment (it WAS deposited → real cash). */
  linkedToDeposit: boolean;
  // ── Review detail (optional — populated by the preview endpoint so the
  //    bookkeeper can decide "phantom or real" per payment) ──
  /** Payment date (TxnDate). */
  date?: string | null;
  /** Reference / check number on the payment. */
  refNum?: string | null;
  /** Payment method name (Visa, Cash, e-Transfer, …). */
  method?: string | null;
  /** Portion not applied to any invoice. */
  unappliedAmt?: number | null;
  /** The bank Deposit(s) that swept this payment, when linkedToDeposit. */
  sweptBy?: Array<{ date: string; amount: number; account: string | null }>;
}

export type RemediationAction = "void_payment_and_invoice" | "void_invoice_only" | "review";

export interface RemediationInvoice {
  invoiceId: string;
  docNumber: string | null;
  customer: string | null;
  date: string;
  total: number;
  balance: number;
  incomeAccounts: string[];
  payments: RemediationPayment[];
  action: RemediationAction;
  /** Safe to auto-void (all linked payments are phantom UF, or none). */
  safe: boolean;
  reason: string;
  // ── Review detail (optional passthrough from the preview endpoint) ──
  /** Invoice TotalAmt (gross incl. tax) — vs `total` which is the recognized net. */
  grossTotal?: number | null;
  /** First few line descriptions — identifies the job at a glance. */
  lineSamples?: string[];
}

/** Undeposited-Funds account names across QBO locales/versions. */
export function isUndepositedFunds(accountName: string | null | undefined): boolean {
  return /undeposited\s*funds|payments?\s+to\s+deposit/i.test(accountName || "");
}

/**
 * A payment is a safe-to-void PHANTOM only if it sits in Undeposited Funds AND
 * no Deposit has swept it (linkedToDeposit=false). Anything else is real cash.
 */
export function isPhantomPayment(p: RemediationPayment): boolean {
  return isUndepositedFunds(p.depositAccount) && !p.linkedToDeposit;
}

const r2 = (n: number) => Math.round((n || 0) * 100) / 100;

/** Decide the QBO action for one recognized CRM invoice + its payments. */
export function planInvoice(
  inv: {
    invoiceId: string;
    docNumber: string | null;
    customer: string | null;
    date: string;
    total: number;
    balance: number;
    incomeAccounts: string[];
    grossTotal?: number | null;
    lineSamples?: string[];
  },
  payments: RemediationPayment[]
): RemediationInvoice {
  const base = {
    invoiceId: inv.invoiceId,
    docNumber: inv.docNumber,
    customer: inv.customer,
    date: inv.date,
    total: r2(inv.total),
    balance: r2(inv.balance),
    incomeAccounts: inv.incomeAccounts,
    grossTotal: inv.grossTotal ?? null,
    lineSamples: inv.lineSamples || [],
    payments,
  };

  if (payments.length === 0) {
    // No payment to unwind — voiding the invoice only removes the doc + its
    // A/R. On cash basis an unpaid invoice isn't income, so no cash impact.
    return { ...base, action: "void_invoice_only", safe: true, reason: "No linked payment — void the invoice (removes the CRM doc; no cash effect)." };
  }

  const realCash = payments.filter((p) => !isPhantomPayment(p));
  if (realCash.length > 0) {
    const where = realCash
      .map((p) => (p.linkedToDeposit ? "swept into a Deposit" : `deposited to "${p.depositAccount || "?"}"`))
      .join(", ");
    return {
      ...base,
      action: "review",
      safe: false,
      reason: `A linked payment is REAL cash (${where}) — voiding it would remove money. Review manually; don't auto-void.`,
    };
  }

  // Every payment is a phantom UF entry → safe to void payment(s) then invoice.
  return {
    ...base,
    action: "void_payment_and_invoice",
    safe: true,
    reason: `${payments.length} phantom payment(s) sitting in Undeposited Funds (never deposited — the real cash is the separate income deposit). Void payment(s) then the invoice.`,
  };
}

export interface RemediationSummary {
  total: number;
  safe: number;
  review: number;
  voidInvoiceOnly: number;
  safeInvoiceAmount: number;
  reviewInvoiceAmount: number;
}

export function summarizeRemediation(invoices: RemediationInvoice[]): RemediationSummary {
  const s: RemediationSummary = {
    total: invoices.length,
    safe: 0,
    review: 0,
    voidInvoiceOnly: 0,
    safeInvoiceAmount: 0,
    reviewInvoiceAmount: 0,
  };
  for (const inv of invoices) {
    if (inv.action === "review") {
      s.review++;
      s.reviewInvoiceAmount = r2(s.reviewInvoiceAmount + inv.total);
    } else {
      s.safe++;
      s.safeInvoiceAmount = r2(s.safeInvoiceAmount + inv.total);
      if (inv.action === "void_invoice_only") s.voidInvoiceOnly++;
    }
  }
  return s;
}
