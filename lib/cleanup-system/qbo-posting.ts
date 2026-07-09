/**
 * QBO write helpers for BS cleanup proposed entries.
 */

import { applyPaymentToInvoices, applyBillPaymentToBills, createJournalEntry } from "@/lib/qbo";

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function qboFetch(
  realmId: string,
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<any> {
  const res = await fetch(`${QBO_BASE}/v3/company/${realmId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`QBO ${res.status} ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function voidQboInvoice(
  realmId: string,
  accessToken: string,
  invoiceId: string,
  privateNote?: string
): Promise<string> {
  const query = encodeURIComponent(`SELECT * FROM Invoice WHERE Id = '${invoiceId}'`);
  const data = await qboFetch(realmId, accessToken, `/query?query=${query}`, { method: "GET" });
  const inv = data?.QueryResponse?.Invoice?.[0];
  if (!inv) throw new Error(`Invoice ${invoiceId} not found in QBO`);

  const voidPayload: Record<string, unknown> = {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
  };
  if (privateNote) voidPayload.PrivateNote = privateNote;

  const voidRes = await qboFetch(
    realmId,
    accessToken,
    "/invoice?operation=void&minorversion=70",
    { method: "POST", body: JSON.stringify(voidPayload) }
  );
  return voidRes?.Invoice?.Id || invoiceId;
}

export async function applyUfPaymentToInvoice(
  realmId: string,
  accessToken: string,
  params: {
    paymentId: string;
    invoiceId: string;
    amount: number;
    runId: string;
    entryId: string;
  }
): Promise<string> {
  const idempotencyToken = `SNAP-CLEANUP-${params.runId}-${params.entryId}`;
  const result = await applyPaymentToInvoices(realmId, accessToken, {
    paymentId: params.paymentId,
    invoiceLinks: [{ invoiceId: params.invoiceId, amountApplied: params.amount }],
    privateNote: `Ironbooks BS Cleanup UF→A/R — ${idempotencyToken}`,
  });
  return result?.Id || params.paymentId;
}

export async function applyApPaymentToBill(
  realmId: string,
  accessToken: string,
  params: {
    billPaymentId: string;
    billId: string;
    amount: number;
    runId: string;
    entryId: string;
  }
): Promise<string> {
  const idempotencyToken = `SNAP-CLEANUP-AP-${params.runId}-${params.entryId}`;
  const result = await applyBillPaymentToBills(realmId, accessToken, {
    billPaymentId: params.billPaymentId,
    billLinks: [{ billId: params.billId, amountApplied: params.amount }],
    privateNote: `Ironbooks BS Cleanup payment→Bill — ${idempotencyToken}`,
  });
  return result?.Id || params.billPaymentId;
}

export { createJournalEntry };
