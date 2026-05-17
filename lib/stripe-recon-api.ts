/**
 * Deterministic Stripe AR reconciliation for clients with Stripe Connect.
 *
 * Skips the AI matcher entirely. Pulls payouts + charges directly from
 * Stripe, computes exact fees and customer attribution, then matches each
 * Stripe payout to the QBO Deposit it produced (by arrival_date + amount).
 *
 * For each QBO Deposit we know:
 *   - exact gross charges (sum of charge.amount)
 *   - exact fee (sum of balance_transaction.fee where type='charge')
 *   - per-charge customer email + Stripe invoice id
 *
 * If a charge's customer email matches a QBO customer's PrimaryEmailAddr,
 * we link it. Otherwise the charge is still recorded with its Stripe
 * customer detail so the bookkeeper has full context.
 */

import {
  listPayoutsInRange,
  listBalanceTransactionsForPayout,
  getCharge,
  type StripePayout,
  type StripeCharge,
} from "./stripe-api";
import { getProvinceTax, getServiceTaxRate } from "./canadian-tax";
import type {
  StripeDeposit,
  QBOInvoice,
} from "./qbo-stripe-recon";
import type {
  DepositMatch,
  InvoiceMatch,
  CandidateInvoice,
  CandidatePayment,
} from "./claude-stripe-match";

interface QBOCustomer {
  id: string;
  display_name: string;
  primary_email: string | null;
}

export interface StripeApiMatchResult {
  matches: DepositMatch[];
  warnings: string[];
  summary: string;
  /** Stripe payouts we found but couldn't pair with a QBO deposit. */
  unmatched_payouts: Array<{
    payout_id: string;
    arrival_date: string;
    amount: number;
    reason: string;
  }>;
}

interface RunParams {
  accessToken: string;          // Stripe connected-account access token
  jurisdiction: "US" | "CA";
  stateProvince: string;
  /** QBO Deposits we already pulled (Stripe-flagged), to match payouts against */
  qboDeposits: StripeDeposit[];
  /** QBO invoices in the (widened) date range, for invoice→amount lookup */
  qboInvoices: QBOInvoice[];
  /** QBO customers, for email matching */
  qboCustomers: QBOCustomer[];
  /** Stripe payout arrival range — usually matches the job's date range */
  arrivalStartISO: string;
  arrivalEndISO: string;
}

const cents = (n: number): number => Math.round(n);
const dollars = (c: number): number => Number((c / 100).toFixed(2));

export async function reconcileViaStripeApi(
  params: RunParams
): Promise<StripeApiMatchResult> {
  const warnings: string[] = [];

  // 1. Pull payouts
  const payouts = await listPayoutsInRange(
    params.accessToken,
    params.arrivalStartISO,
    params.arrivalEndISO
  );

  if (payouts.length === 0) {
    return {
      matches: [],
      warnings: [
        "No Stripe payouts found in the date range for this connected account. Either Stripe didn't pay out during this period, or the connected account has no charges.",
      ],
      summary: "No Stripe payouts in range.",
      unmatched_payouts: [],
    };
  }

  // 2. For each payout, get the balance-transaction list and enrich charges
  const customerByEmail = new Map<string, QBOCustomer>();
  for (const c of params.qboCustomers) {
    if (c.primary_email) {
      customerByEmail.set(c.primary_email.toLowerCase(), c);
    }
  }
  const invoiceById = new Map(params.qboInvoices.map((i) => [i.id, i]));

  // Province tax setup (Canada only)
  const provinceTax =
    params.jurisdiction === "CA" ? getProvinceTax(params.stateProvince) : null;
  const serviceTaxRate =
    params.jurisdiction === "CA" ? getServiceTaxRate(params.stateProvince) : 0;
  const taxCode = provinceTax?.serviceTax.components.join(" + ") || null;

  // Index QBO deposits by amount+date for payout pairing
  const qboDepositsByAmount = new Map<string, StripeDeposit[]>();
  for (const d of params.qboDeposits) {
    const key = Math.round(d.amount * 100).toString();
    const list = qboDepositsByAmount.get(key) || [];
    list.push(d);
    qboDepositsByAmount.set(key, list);
  }

  const matches: DepositMatch[] = [];
  const unmatched_payouts: StripeApiMatchResult["unmatched_payouts"] = [];
  const usedQboDepositIds = new Set<string>();

  for (const payout of payouts) {
    let bts;
    try {
      bts = await listBalanceTransactionsForPayout(params.accessToken, payout.id);
    } catch (err: any) {
      warnings.push(`Could not load transactions for payout ${payout.id}: ${err.message}`);
      continue;
    }

    // Sum gross charges and fees from balance transactions (charge type only —
    // refunds and adjustments are handled separately so the fee math is clean)
    let grossCents = 0;
    let feeCents = 0;
    const chargeIds: string[] = [];
    for (const bt of bts) {
      if (bt.type === "charge" && bt.source) {
        grossCents += bt.amount;
        feeCents += bt.fee;
        chargeIds.push(bt.source);
      } else if (bt.type === "refund") {
        grossCents += bt.amount; // negative
        feeCents += bt.fee;
      } else if (bt.type === "stripe_fee" || bt.type === "adjustment") {
        // Standalone fees / adjustments — fold into fee total
        feeCents += -bt.amount;
      }
    }

    // Pair with a QBO deposit by exact amount (in cents). If multiple, take
    // the closest arrival_date.
    const payoutAmountKey = payout.amount.toString();
    const candidates = (qboDepositsByAmount.get(payoutAmountKey) || []).filter(
      (d) => !usedQboDepositIds.has(d.qbo_deposit_id)
    );

    let pairedDeposit: StripeDeposit | null = null;
    if (candidates.length > 0) {
      const arrivalDate = new Date(payout.arrival_date * 1000)
        .toISOString()
        .slice(0, 10);
      candidates.sort((a, b) => {
        const da = Math.abs(new Date(a.date).getTime() - new Date(arrivalDate).getTime());
        const db = Math.abs(new Date(b.date).getTime() - new Date(arrivalDate).getTime());
        return da - db;
      });
      pairedDeposit = candidates[0];
      usedQboDepositIds.add(pairedDeposit.qbo_deposit_id);
    }

    if (!pairedDeposit) {
      unmatched_payouts.push({
        payout_id: payout.id,
        arrival_date: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
        amount: dollars(payout.amount),
        reason:
          "Stripe says this payout was made but no Stripe-flagged QBO Deposit matches the amount. Check that the QBO deposit exists and is on a Stripe clearing account.",
      });
      continue;
    }

    // 3. Enrich each charge with customer info (in parallel, cap concurrency 5)
    const enrichedCharges: StripeCharge[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < chargeIds.length; i += CONCURRENCY) {
      const batch = chargeIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((id) => getCharge(params.accessToken, id))
      );
      for (const r of results) {
        if (r.status === "fulfilled") enrichedCharges.push(r.value);
      }
    }

    // 4. Build per-customer invoice matches.
    //   For each Stripe charge:
    //     - get the receipt_email / billing_details.email / customer email
    //     - if we can find a matching QBO customer by email, attribute the
    //       charge amount to that customer
    //     - if Stripe's `invoice` field is set, try to find the QBO invoice
    //       with that Stripe invoice id stored in PrivateNote/DocNumber
    //       (best-effort; not all clients sync invoice IDs back)
    const customerTotals = new Map<
      string,
      { customer_name: string; gross_cents: number; charge_ids: string[]; emails: Set<string> }
    >();
    const unattributed: { gross_cents: number; charge_ids: string[] } = { gross_cents: 0, charge_ids: [] };

    for (const ch of enrichedCharges) {
      const email = (ch.receipt_email || ch.billing_details?.email || "").toLowerCase().trim();
      const qboCust = email ? customerByEmail.get(email) : undefined;
      if (qboCust) {
        const entry =
          customerTotals.get(qboCust.id) ||
          {
            customer_name: qboCust.display_name,
            gross_cents: 0,
            charge_ids: [] as string[],
            emails: new Set<string>(),
          };
        entry.gross_cents += ch.amount;
        entry.charge_ids.push(ch.id);
        if (email) entry.emails.add(email);
        customerTotals.set(qboCust.id, entry);
      } else {
        // No QBO customer match — record by Stripe customer/email as unattributed
        unattributed.gross_cents += ch.amount;
        unattributed.charge_ids.push(ch.id);
      }
    }

    const matchedInvoices: InvoiceMatch[] = [];
    for (const [qboCustId, entry] of customerTotals) {
      const grossDollars = dollars(entry.gross_cents);
      let preTax = grossDollars;
      let taxAmount = 0;
      if (serviceTaxRate > 0) {
        preTax = grossDollars / (1 + serviceTaxRate);
        taxAmount = grossDollars - preTax;
      }
      matchedInvoices.push({
        invoice_id: qboCustId, // we don't have a per-invoice link from Stripe; attribute at customer level
        customer_name: entry.customer_name,
        amount: Number(grossDollars.toFixed(2)),
        pre_tax_amount: Number(preTax.toFixed(2)),
        tax_amount: Number(taxAmount.toFixed(2)),
      });
    }

    // If we have unattributed Stripe charges, add an "Unmatched (Stripe)" line
    // so the totals reconcile and the bookkeeper sees what's missing.
    if (unattributed.gross_cents > 0) {
      const grossDollars = dollars(unattributed.gross_cents);
      let preTax = grossDollars;
      let taxAmount = 0;
      if (serviceTaxRate > 0) {
        preTax = grossDollars / (1 + serviceTaxRate);
        taxAmount = grossDollars - preTax;
      }
      matchedInvoices.push({
        invoice_id: `_stripe_unattributed_${payout.id}`,
        customer_name: `Unmatched Stripe customers (${unattributed.charge_ids.length} charge${unattributed.charge_ids.length === 1 ? "" : "s"})`,
        amount: Number(grossDollars.toFixed(2)),
        pre_tax_amount: Number(preTax.toFixed(2)),
        tax_amount: Number(taxAmount.toFixed(2)),
      });
    }

    const totalInvoiceAmount = dollars(grossCents);
    const computedFeeRaw = dollars(feeCents);
    const preTaxFee =
      serviceTaxRate > 0
        ? computedFeeRaw / (1 + serviceTaxRate)
        : computedFeeRaw;
    const computedTax = computedFeeRaw - preTaxFee;

    const customerNames = Array.from(
      new Set(matchedInvoices.map((m) => m.customer_name).filter(Boolean) as string[])
    );

    // Stripe-truth match: confidence is 1.0, decision auto_approve
    matches.push({
      qbo_deposit_id: pairedDeposit.qbo_deposit_id,
      deposit_amount: pairedDeposit.amount,
      deposit_date: pairedDeposit.date,
      deposit_memo: pairedDeposit.memo,
      matched_invoices: matchedInvoices,
      matched_customer_names: customerNames,
      total_invoice_amount: Number(totalInvoiceAmount.toFixed(2)),
      pre_tax_revenue: Number(
        matchedInvoices.reduce((s, m) => s + m.pre_tax_amount, 0).toFixed(2)
      ),
      total_sales_tax_collected: Number(
        matchedInvoices.reduce((s, m) => s + m.tax_amount, 0).toFixed(2)
      ),
      computed_fee: Number(preTaxFee.toFixed(2)),
      computed_tax: Number(computedTax.toFixed(2)),
      tax_code: taxCode,
      ai_confidence: 1.0,
      ai_reasoning: `Matched via Stripe API: payout ${payout.id} → ${enrichedCharges.length} charge${enrichedCharges.length === 1 ? "" : "s"}, exact fee ${computedFeeRaw.toFixed(2)}.`,
      decision: "auto_approve",
      candidate_invoices: [] as CandidateInvoice[],
      candidate_payments: [] as CandidatePayment[],
    });
  }

  // Any QBO deposits we didn't pair → flagged with a clear reason
  for (const dep of params.qboDeposits) {
    if (usedQboDepositIds.has(dep.qbo_deposit_id)) continue;
    matches.push({
      qbo_deposit_id: dep.qbo_deposit_id,
      deposit_amount: dep.amount,
      deposit_date: dep.date,
      deposit_memo: dep.memo,
      matched_invoices: [],
      matched_customer_names: [],
      total_invoice_amount: 0,
      pre_tax_revenue: 0,
      total_sales_tax_collected: 0,
      computed_fee: 0,
      computed_tax: 0,
      tax_code: taxCode,
      ai_confidence: 0,
      ai_reasoning:
        "Stripe API path: no Stripe payout matched this QBO deposit's amount. Either the deposit isn't from Stripe, or it's from a different connected account. Inspect the deposit memo and account.",
      decision: "flagged",
      candidate_invoices: [] as CandidateInvoice[],
      candidate_payments: [] as CandidatePayment[],
    });
  }

  if (unmatched_payouts.length > 0) {
    warnings.push(
      `${unmatched_payouts.length} Stripe payout${unmatched_payouts.length === 1 ? "" : "s"} had no matching QBO deposit. Check that those deposits were imported into QBO and posted to a Stripe clearing account.`
    );
  }

  const autoCount = matches.filter((m) => m.decision === "auto_approve").length;
  const flaggedCount = matches.filter((m) => m.decision === "flagged").length;
  void invoiceById; // future-proofing for per-invoice attribution

  return {
    matches,
    warnings,
    summary: `Stripe API: ${autoCount} payouts reconciled, ${flaggedCount} unmatched.`,
    unmatched_payouts,
  };
}
