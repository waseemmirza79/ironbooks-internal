/**
 * Accounts Payable discovery — the AP mirror of the UF→AR matcher.
 *
 * Three payables messes on every neglected file:
 *   1. Unapplied BillPayments — the vendor got paid, the bill still shows
 *      open. Fix = link payment → bill (applyBillPaymentToBills), proposed
 *      as entry_type "bill_payment".
 *   2. Vendor credits sitting unapplied against open bills — flagged (the
 *      credit-application write is riskier; v1 keeps it human).
 *   3. Bills ALSO paid via a direct Purchase/cheque (paid outside AP) —
 *      expense double-counted AND the bill still open. Flagged with both
 *      sides identified; the fix (void one side) is a judgment call.
 *
 * Matching is deterministic: same vendor + amount, tightest window first.
 * No AI sets amounts. Everything is propose → approve → execute.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken, qboRequest } from "@/lib/qbo";

export interface OpenBill {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  docNumber: string | null;
  txnDate: string;
  totalAmt: number;
  balance: number;
}

export interface UnappliedBillPayment {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  txnDate: string;
  totalAmt: number;
  unapplied: number; // TotalAmt − already-linked lines
}

export interface OpenVendorCredit {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  txnDate: string;
  balance: number;
}

export type ApMatchKind = "exact_amount" | "amount_within_window" | "unmatched";

export interface ApMatch {
  kind: ApMatchKind;
  payment: UnappliedBillPayment;
  bill: OpenBill | null;
  amountApplied: number;
  confidence: number;
  reasoning: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (a: string, b: string) =>
  Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

/** Deterministic payment→bill matching. Consumes bills as they're claimed so
 *  two payments never propose against the same bill balance. */
export function matchApPayments(
  bills: OpenBill[],
  payments: UnappliedBillPayment[]
): ApMatch[] {
  const remaining = new Map(bills.map((b) => [b.id, b.balance]));
  const out: ApMatch[] = [];

  // Oldest payments first — FIFO, mirrors the AR matcher convention.
  const ordered = [...payments].sort((a, b) => (a.txnDate < b.txnDate ? -1 : 1));

  for (const p of ordered) {
    if (p.unapplied < 0.01) continue;
    const sameVendor = bills.filter(
      (b) =>
        (remaining.get(b.id) || 0) > 0.005 &&
        p.vendorId &&
        b.vendorId === p.vendorId
    );

    // 1. Exact: unapplied equals one bill's outstanding balance.
    const exact = sameVendor
      .filter((b) => Math.abs((remaining.get(b.id) || 0) - p.unapplied) <= 0.01)
      .sort((a, b) => daysBetween(a.txnDate, p.txnDate) - daysBetween(b.txnDate, p.txnDate));
    if (exact.length === 1) {
      const bill = exact[0];
      out.push({
        kind: "exact_amount",
        payment: p,
        bill,
        amountApplied: round2(p.unapplied),
        confidence: 0.92,
        reasoning: `Payment of $${p.unapplied.toFixed(2)} equals the open balance on bill ${bill.docNumber || bill.id} (same vendor, ${Math.round(daysBetween(bill.txnDate, p.txnDate))}d apart)`,
      });
      remaining.set(bill.id, 0);
      continue;
    }
    if (exact.length > 1) {
      // Ambiguous exact matches — pick closest date but mark lower confidence.
      const bill = exact[0];
      out.push({
        kind: "amount_within_window",
        payment: p,
        bill,
        amountApplied: round2(p.unapplied),
        confidence: 0.75,
        reasoning: `${exact.length} open bills share this exact amount for the vendor — proposing the closest-dated (${bill.docNumber || bill.id}); verify before approving`,
      });
      remaining.set(bill.id, 0);
      continue;
    }

    // 2. Partial: payment fits inside one bill's balance, within 60 days.
    const partial = sameVendor
      .filter(
        (b) =>
          (remaining.get(b.id) || 0) - p.unapplied > 0.01 &&
          daysBetween(b.txnDate, p.txnDate) <= 60
      )
      .sort((a, b) => daysBetween(a.txnDate, p.txnDate) - daysBetween(b.txnDate, p.txnDate));
    if (partial.length >= 1) {
      const bill = partial[0];
      out.push({
        kind: "amount_within_window",
        payment: p,
        bill,
        amountApplied: round2(p.unapplied),
        confidence: 0.7,
        reasoning: `Partial payment: $${p.unapplied.toFixed(2)} against bill ${bill.docNumber || bill.id} ($${(remaining.get(bill.id) || 0).toFixed(2)} open, same vendor, closest date)`,
      });
      remaining.set(bill.id, round2((remaining.get(bill.id) || 0) - p.unapplied));
      continue;
    }

    out.push({
      kind: "unmatched",
      payment: p,
      bill: null,
      amountApplied: 0,
      confidence: 0,
      reasoning: p.vendorId
        ? "No open bill for this vendor fits the unapplied amount"
        : "Payment has no vendor reference — can't match",
    });
  }

  return out;
}

/** Purchases that duplicate an open bill (paid outside AP): same vendor,
 *  same total, within ±14 days of the bill date. */
export function findPaidOutsideAp(
  bills: OpenBill[],
  purchases: Array<{ id: string; vendorId: string | null; txnDate: string; totalAmt: number }>
): Array<{ bill: OpenBill; purchaseId: string; purchaseDate: string }> {
  const out: Array<{ bill: OpenBill; purchaseId: string; purchaseDate: string }> = [];
  for (const b of bills) {
    if (!b.vendorId || b.totalAmt < 0.01) continue;
    const dup = purchases.find(
      (p) =>
        p.vendorId === b.vendorId &&
        Math.abs(p.totalAmt - b.totalAmt) <= 0.01 &&
        daysBetween(p.txnDate, b.txnDate) <= 14
    );
    if (dup) out.push({ bill: b, purchaseId: dup.id, purchaseDate: dup.txnDate });
  }
  return out;
}

/** Live QBO pull of the AP state. */
export async function fetchApState(
  service: SupabaseClient,
  clientLinkId: string
): Promise<{
  realmId: string;
  accessToken: string;
  bills: OpenBill[];
  payments: UnappliedBillPayment[];
  credits: OpenVendorCredit[];
}> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  const realmId = (client as any)?.qbo_realm_id as string;
  if (!realmId) throw new Error("Client has no QBO connection");
  const accessToken = await getValidToken(clientLinkId, service);

  const q = async (sql: string) => {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${encodeURIComponent(sql)}`,
      { method: "GET" }
    );
    return data?.QueryResponse || {};
  };

  const bills: OpenBill[] = ((await q(
    `SELECT * FROM Bill WHERE Balance > '0' ORDERBY TxnDate ASC MAXRESULTS 300`
  )).Bill || []).map((b: any) => ({
    id: String(b.Id),
    vendorId: b.VendorRef?.value ? String(b.VendorRef.value) : null,
    vendorName: b.VendorRef?.name || null,
    docNumber: b.DocNumber || null,
    txnDate: String(b.TxnDate || ""),
    totalAmt: Number(b.TotalAmt || 0),
    balance: Number(b.Balance || 0),
  }));

  const payments: UnappliedBillPayment[] = ((await q(
    `SELECT * FROM BillPayment ORDERBY TxnDate DESC MAXRESULTS 300`
  )).BillPayment || [])
    .map((p: any) => {
      const applied = (Array.isArray(p.Line) ? p.Line : []).reduce(
        (s: number, l: any) => s + Number(l.Amount || 0),
        0
      );
      return {
        id: String(p.Id),
        vendorId: p.VendorRef?.value ? String(p.VendorRef.value) : null,
        vendorName: p.VendorRef?.name || null,
        txnDate: String(p.TxnDate || ""),
        totalAmt: Number(p.TotalAmt || 0),
        unapplied: round2(Number(p.TotalAmt || 0) - applied),
      };
    })
    .filter((p: UnappliedBillPayment) => p.unapplied > 0.01);

  const credits: OpenVendorCredit[] = ((await q(
    `SELECT * FROM VendorCredit ORDERBY TxnDate DESC MAXRESULTS 200`
  )).VendorCredit || [])
    .map((c: any) => ({
      id: String(c.Id),
      vendorId: c.VendorRef?.value ? String(c.VendorRef.value) : null,
      vendorName: c.VendorRef?.name || null,
      txnDate: String(c.TxnDate || ""),
      balance: Number(c.Balance ?? c.TotalAmt ?? 0),
    }))
    .filter((c: OpenVendorCredit) => c.balance > 0.01);

  return { realmId, accessToken, bills, payments, credits };
}

/** Purchases that could duplicate the given open bills — one TotalAmt-keyed
 *  query per distinct amount (Purchase EntityRef isn't queryable). Capped. */
export async function fetchDuplicateCandidatePurchases(
  realmId: string,
  accessToken: string,
  bills: OpenBill[]
): Promise<Array<{ id: string; vendorId: string | null; txnDate: string; totalAmt: number }>> {
  const q = async (sql: string) => {
    const data: any = await qboRequest(
      realmId,
      accessToken,
      `/query?query=${encodeURIComponent(sql)}`,
      { method: "GET" }
    );
    return data?.QueryResponse || {};
  };
  const amounts = [...new Set(bills.slice(0, 40).map((b) => b.totalAmt.toFixed(2)))];
  const out: Array<{ id: string; vendorId: string | null; txnDate: string; totalAmt: number }> = [];
  for (const amt of amounts) {
    try {
      const res = await q(`SELECT * FROM Purchase WHERE TotalAmt = '${amt}' MAXRESULTS 20`);
      for (const p of res.Purchase || []) {
        out.push({
          id: String(p.Id),
          vendorId: p.EntityRef?.value ? String(p.EntityRef.value) : null,
          txnDate: String(p.TxnDate || ""),
          totalAmt: Number(p.TotalAmt || 0),
        });
      }
    } catch {
      /* per-amount query best-effort */
    }
  }
  return out;
}
