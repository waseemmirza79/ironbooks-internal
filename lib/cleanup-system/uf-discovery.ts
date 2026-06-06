/**
 * Undeposited Funds discovery — uses production matchUFtoAR matcher.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";
import {
  fetchOpenInvoices,
  fetchUndepositedFundsPayments,
  findUndepositedFundsAccountId,
} from "@/lib/qbo-balance-sheet";
import { matchUFtoAR } from "@/lib/uf-ar-matcher";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import { createProposedEntry } from "./proposed-entries";
import { serializeMeta, ufKindToDecision, type UfEntryMeta } from "./entry-meta";

export async function discoverUndepositedFundsModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number; matches: number; skipped: number }> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) throw new Error("Client not found");

  const token = await getValidToken(clientLinkId, service);
  const realmId = (client as any).qbo_realm_id as string;
  if (!realmId) throw new Error("Client has no QuickBooks connection");

  const invoices = await fetchOpenInvoices(realmId, token);
  let ufPayments: Awaited<ReturnType<typeof fetchUndepositedFundsPayments>> = [];
  const ufAcctId = await findUndepositedFundsAccountId(realmId, token);
  if (ufAcctId) {
    ufPayments = await fetchUndepositedFundsPayments(realmId, token, ufAcctId);
  }

  const matches = matchUFtoAR(ufPayments, invoices);
  let proposed = 0;
  let matchCount = 0;
  let skipped = 0;

  for (const m of matches) {
    const pay = m.payment;
    const picked = m.proposed[0] || null;

    const meta: UfEntryMeta = {
      v: 1,
      type: "uf_match",
      kind: m.kind,
      reasoning: m.reasoning,
      customer_name: pay.customer_name,
      payment_id: pay.qbo_payment_id,
      proposed_invoice_id: picked?.qbo_invoice_id || null,
      proposed_doc_number: picked?.doc_number || null,
      candidates: m.candidates.map((c) => ({
        qbo_invoice_id: c.qbo_invoice_id,
        doc_number: c.doc_number,
        balance: c.balance,
        customer_name: c.customer_name,
        txn_date: c.txn_date,
      })),
    };

    let cpaFlagId: string | undefined;
    if (pay.date && requiresCpaFlag(pay.date, periodLockDate, "income")) {
      cpaFlagId = await createCpaFlag(service, {
        clientLinkId,
        runId,
        flagType: "prior_year_income",
        description: `UF payment ${pay.qbo_payment_id} dated ${pay.date} is in a closed period`,
        impactSummary: "May affect prior-year income recognition",
      });
    }

    const decision = cpaFlagId ? "flagged" : ufKindToDecision(m.kind);

    if (m.kind === "unmatched" || !picked) {
      await createProposedEntry(service, {
        runId,
        clientLinkId,
        module: "undeposited_funds",
        entryType: "receive_payment",
        amount: pay.amount,
        txnDate: pay.date,
        memo: `UF manual review: ${pay.customer_name || "unknown customer"}`,
        qboTransactionId: pay.qbo_payment_id,
        qboTransactionType: "Payment",
        periodImpact: cpaFlagId ? "cpa_blocked" : "current",
        cpaFlagId,
        decisionOverride: decision,
        aiReasoning: serializeMeta(meta),
        confidenceOverride: m.confidence,
      });
      skipped++;
      proposed++;
      continue;
    }

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "undeposited_funds",
      entryType: "receive_payment",
      amount: pay.amount,
      txnDate: pay.date,
      memo: `UF → invoice #${picked.doc_number || picked.qbo_invoice_id}: ${pay.customer_name}`,
      qboTransactionId: pay.qbo_payment_id,
      qboTransactionType: "Payment",
      toAccountId: picked.qbo_invoice_id,
      toAccountName: picked.doc_number || picked.customer_name || "Invoice",
      periodImpact: cpaFlagId ? "cpa_blocked" : "current",
      cpaFlagId,
      decisionOverride: decision,
      aiReasoning: serializeMeta(meta),
      confidenceOverride: m.confidence,
    });
    proposed++;
    matchCount++;
  }

  await service
    .from("cleanup_run_modules")
    .update({
      status: "reviewing",
      proposed_count: proposed,
      updated_at: new Date().toISOString(),
    } as any)
    .eq("run_id", runId)
    .eq("module", "undeposited_funds");

  return { proposed, matches: matchCount, skipped };
}
