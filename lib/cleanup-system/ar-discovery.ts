/**
 * Accounts Receivable discovery — duplicate invoice detection (CRM + heuristic).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import {
  detectDuplicates,
  normalizeCrmRows,
  parseCsv,
  type CrmSource,
} from "@/lib/hardcore-cleanup";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import { createProposedEntry } from "./proposed-entries";
import {
  duplicateConfidenceToDecision,
  serializeMeta,
  type ArDuplicateMeta,
} from "./entry-meta";

export interface ArDiscoverOptions {
  crmSource?: CrmSource;
  crmCsvText?: string;
}

export async function discoverAccountsReceivableModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string,
  options: ArDiscoverOptions = {}
): Promise<{ proposed: number; duplicates: number }> {
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

  let crmJobs: ReturnType<typeof normalizeCrmRows> = [];
  if (options.crmCsvText?.trim() && options.crmSource) {
    const rows = parseCsv(options.crmCsvText);
    crmJobs = normalizeCrmRows(rows, options.crmSource);
  }

  const { duplicates } = detectDuplicates({ crmJobs, qboInvoices: invoices });
  let proposed = 0;

  for (const dup of duplicates) {
    const inv = dup.qbo_invoice;
    const meta: ArDuplicateMeta = {
      v: 1,
      type: "ar_duplicate",
      reasoning: dup.reasoning,
      survivor_invoice_id: dup.surviving_qbo_invoice.qbo_invoice_id,
      survivor_doc_number: dup.surviving_qbo_invoice.doc_number,
      confidence: dup.confidence,
    };

    let cpaFlagId: string | undefined;
    if (inv.txn_date && requiresCpaFlag(inv.txn_date, periodLockDate, "income")) {
      cpaFlagId = await createCpaFlag(service, {
        clientLinkId,
        runId,
        flagType: "prior_year_income",
        description: `Duplicate invoice ${inv.doc_number || inv.qbo_invoice_id} dated ${inv.txn_date} is in a closed period`,
      });
    }

    const decision = cpaFlagId ? "flagged" : duplicateConfidenceToDecision(dup.confidence);

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "accounts_receivable",
      entryType: "void",
      amount: Number(inv.balance || inv.total_amount || 0),
      txnDate: inv.txn_date,
      memo: `Void duplicate invoice #${inv.doc_number || inv.qbo_invoice_id} (keep #${dup.surviving_qbo_invoice.doc_number || dup.surviving_qbo_invoice.qbo_invoice_id})`,
      qboTransactionId: inv.qbo_invoice_id,
      qboTransactionType: "Invoice",
      periodImpact: cpaFlagId ? "cpa_blocked" : "current",
      cpaFlagId,
      decisionOverride: decision,
      aiReasoning: serializeMeta(meta),
      confidenceOverride: dup.confidence,
      toAccountId: dup.surviving_qbo_invoice.qbo_invoice_id,
      toAccountName: dup.surviving_qbo_invoice.doc_number || "survivor",
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({
      status: "reviewing",
      proposed_count: proposed,
      updated_at: new Date().toISOString(),
    } as any)
    .eq("run_id", runId)
    .eq("module", "accounts_receivable");

  return { proposed, duplicates: duplicates.length };
}
