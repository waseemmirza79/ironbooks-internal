/**
 * Module discovery — wraps existing BS modules under the orchestrator.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken } from "@/lib/qbo";
import {
  fetchUndepositedFundsPayments,
  fetchOpenInvoices,
  findUndepositedFundsAccountId,
} from "@/lib/qbo-balance-sheet";
import { findBestMatch, type MatchCandidate } from "./matching-engine";
import { createProposedEntry } from "./proposed-entries";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import type { CleanupModule } from "./types";

export async function discoverBankReconModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  const { data: recons } = await service
    .from("bank_recon_jobs")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .eq("cleanup_run_id", runId);

  let proposed = 0;
  for (const recon of recons || []) {
    const gap = Number((recon as any).gap_amount || 0);
    if (Math.abs(gap) < 0.01) continue;

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "bank_recon",
      entryType: "journal_entry",
      amount: Math.abs(gap),
      txnDate: (recon as any).statement_as_of_date,
      memo: `Bank recon gap for ${(recon as any).qbo_account_name}`,
      jeLines: [
        {
          side: gap > 0 ? "debit" : "credit",
          account_hint: (recon as any).qbo_account_name,
          amount: Math.abs(gap),
          description: "Statement reconciliation adjustment",
        },
        {
          side: gap > 0 ? "credit" : "debit",
          account_hint: "Balance Sheet Cleanup Clearing",
          amount: Math.abs(gap),
          description: "Clearing offset",
        },
      ],
      periodImpact: "clearing_entry",
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "bank_recon");

  return { proposed };
}

export async function discoverUndepositedFundsModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number; matches: number }> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) throw new Error("Client not found");

  const token = await getValidToken(clientLinkId, service);
  const realmId = (client as any).qbo_realm_id;

  const ufAccountId = await findUndepositedFundsAccountId(realmId, token);
  const ufPayments = ufAccountId
    ? await fetchUndepositedFundsPayments(realmId, token, ufAccountId)
    : [];
  const openInvoices = await fetchOpenInvoices(realmId, token);

  const importedRecords = await service
    .from("imported_records")
    .select("*")
    .eq("run_id", runId);

  const bankSources: MatchCandidate[] = (importedRecords.data || []).map((r: any) => ({
    id: r.id,
    amount: Number(r.net_amount || r.gross_amount || 0),
    date: r.record_date,
    payer: r.payer_raw,
    reference: r.reference,
    fee: Number(r.fee_amount || 0),
    payout_id: r.payout_id,
  }));

  let proposed = 0;
  let matches = 0;

  for (const uf of ufPayments) {
    if (uf.already_applied) continue;

    const ufCandidate: MatchCandidate = {
      id: uf.qbo_payment_id,
      amount: uf.amount,
      date: uf.date,
      payer: uf.customer_name,
      reference: uf.invoice_reference || null,
    };

    const invoiceTargets: MatchCandidate[] = openInvoices
      .filter((inv) => inv.customer_id === uf.customer_id)
      .map((inv) => ({
        id: inv.qbo_invoice_id,
        amount: inv.balance,
        date: inv.txn_date,
        payer: inv.customer_name,
        reference: inv.doc_number,
      }));

    const bankTargets = bankSources.filter(
      (b) => Math.abs(b.amount - uf.amount) < 1
    );

    const match =
      findBestMatch(ufCandidate, invoiceTargets) ||
      findBestMatch(ufCandidate, bankTargets, bankSources);

    if (match) {
      const { data: reconMatch } = await service
        .from("recon_matches")
        .insert({
          run_id: runId,
          module: "undeposited_funds",
          match_type: match.match_type,
          confidence: match.confidence,
          gross_amount: match.gross_amount,
          fee_amount: match.fee_amount,
          tax_amount: match.tax_amount,
          net_amount: match.net_amount,
          proposed_fix: match.proposed_fix,
          reasons: match.reasons,
          source_record_ids: match.source_record_ids,
          qbo_refs: match.qbo_refs,
        } as any)
        .select("id")
        .single();

      let cpaFlagId: string | undefined;
      if (
        uf.date &&
        requiresCpaFlag(uf.date, periodLockDate, "income")
      ) {
        cpaFlagId = await createCpaFlag(service, {
          clientLinkId,
          runId,
          flagType: "prior_year_income",
          description: `UF payment ${uf.qbo_payment_id} dated ${uf.date} is in closed period`,
          impactSummary: "May affect prior-year income recognition",
        });
      }

      await createProposedEntry(service, {
        runId,
        clientLinkId,
        module: "undeposited_funds",
        entryType: "receive_payment",
        match,
        reconMatchId: reconMatch?.id,
        amount: uf.amount,
        txnDate: uf.date,
        memo: `UF match: ${uf.customer_name}`,
        qboTransactionId: uf.qbo_payment_id,
        qboTransactionType: "Payment",
        periodImpact: cpaFlagId ? "cpa_blocked" : "current",
        cpaFlagId,
      });
      proposed++;
      matches++;
    }
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "undeposited_funds");

  return { proposed, matches };
}

export async function discoverAccountsReceivableModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  // Wrap hardcore cleanup — look for existing run linked to this cleanup
  const { data: hcRun } = await service
    .from("hardcore_cleanup_runs")
    .select("id")
    .eq("client_link_id", clientLinkId)
    .eq("cleanup_run_id", runId)
    .maybeSingle();

  let proposed = 0;
  if (hcRun) {
    const { data: items } = await service
      .from("hardcore_cleanup_items")
      .select("*")
      .eq("run_id", hcRun.id)
      .eq("resolution", "pending");

    for (const item of items || []) {
      await createProposedEntry(service, {
        runId,
        clientLinkId,
        module: "accounts_receivable",
        entryType: "void",
        amount: Number((item as any).qbo_invoice_balance || 0),
        txnDate: (item as any).qbo_invoice_date,
        memo: `Duplicate AR: ${(item as any).qbo_invoice_doc_number}`,
        qboTransactionId: (item as any).qbo_invoice_id,
        qboTransactionType: "Invoice",
      });
      proposed++;
    }
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "accounts_receivable");

  return { proposed };
}

export async function discoverAccountsPayableModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  // Scaffold: AP discovery pulls open bills with payments — extend when QBO bill fetch wired
  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: 0 } as any)
    .eq("run_id", runId)
    .eq("module", "accounts_payable");
  return { proposed: 0 };
}

export async function discoverLoansModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number }> {
  const { data: loanImports } = await service
    .from("imported_records")
    .select("*")
    .eq("run_id", runId)
    .eq("source", "loan_statement");

  let proposed = 0;
  for (const rec of loanImports || []) {
    let cpaFlagId: string | undefined;
    if (
      (rec as any).record_date &&
      requiresCpaFlag((rec as any).record_date, periodLockDate, "equity")
    ) {
      cpaFlagId = await createCpaFlag(service, {
        clientLinkId,
        runId,
        flagType: "prior_year_equity",
        description: `Loan payment ${(rec as any).external_id} in closed period`,
      });
    }

    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "loans",
      entryType: "journal_entry",
      amount: Number((rec as any).gross_amount || 0),
      txnDate: (rec as any).record_date,
      memo: `Loan payment: ${(rec as any).payer_raw}`,
      jeLines: [
        { side: "debit", account_hint: "Loan Principal", amount: Number((rec as any).gross_amount) * 0.8, description: "Principal" },
        { side: "debit", account_hint: "Interest Expense", amount: Number((rec as any).gross_amount) * 0.2, description: "Interest" },
        { side: "credit", account_hint: (rec as any).payer_raw || "Loan Account", amount: Number((rec as any).gross_amount), description: "Payment" },
      ],
      periodImpact: cpaFlagId ? "cpa_blocked" : "current",
      cpaFlagId,
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "loans");

  return { proposed };
}

export async function discoverShareholderDrawsModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: 0 } as any)
    .eq("run_id", runId)
    .eq("module", "shareholder_draws");
  return { proposed: 0 };
}

export async function discoverTaxPayrollModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  periodLockDate: string
): Promise<{ proposed: number }> {
  let cpaFlagId: string | undefined;
  cpaFlagId = await createCpaFlag(service, {
    clientLinkId,
    runId,
    flagType: "tax_payroll_review",
    description: "Sales tax and payroll liabilities require manual tie-out to filed amounts",
    impactSummary: "CPA review recommended before posting tax/payroll adjustments",
  });

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: 0 } as any)
    .eq("run_id", runId)
    .eq("module", "tax_payroll");

  return { proposed: 0 };
}

export async function discoverObeUncategorizedModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("account_grades")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const grades = ((healthScore as any)?.account_grades || []) as Array<{
    qbo_account_id: string;
    account_name: string;
    balance: number;
    module: string;
  }>;

  let proposed = 0;
  for (const acct of grades.filter((g) => g.module === "obe_uncategorized")) {
    if (Math.abs(acct.balance) < 0.01) continue;
    await createProposedEntry(service, {
      runId,
      clientLinkId,
      module: "obe_uncategorized",
      entryType: "journal_entry",
      amount: Math.abs(acct.balance),
      memo: `Zero out ${acct.account_name}`,
      jeLines: [
        {
          side: acct.balance > 0 ? "credit" : "debit",
          account_hint: acct.account_name,
          amount: Math.abs(acct.balance),
          description: "OBE/uncat cleanup",
        },
        {
          side: acct.balance > 0 ? "debit" : "credit",
          account_hint: "Balance Sheet Cleanup Clearing",
          amount: Math.abs(acct.balance),
          description: "Clearing offset",
        },
      ],
      periodImpact: "clearing_entry",
    });
    proposed++;
  }

  await service
    .from("cleanup_run_modules")
    .update({ status: "reviewing", proposed_count: proposed } as any)
    .eq("run_id", runId)
    .eq("module", "obe_uncategorized");

  return { proposed };
}

const DISCOVERERS: Record<
  CleanupModule,
  (service: SupabaseClient, runId: string, clientLinkId: string, periodLockDate: string) => Promise<{ proposed: number }>
> = {
  bank_recon: (s, r, c) => discoverBankReconModule(s, r, c),
  undeposited_funds: (s, r, c, d) => discoverUndepositedFundsModule(s, r, c, d),
  accounts_receivable: (s, r, c) => discoverAccountsReceivableModule(s, r, c),
  accounts_payable: (s, r, c) => discoverAccountsPayableModule(s, r, c),
  loans: (s, r, c, d) => discoverLoansModule(s, r, c, d),
  shareholder_draws: (s, r, c) => discoverShareholderDrawsModule(s, r, c),
  tax_payroll: (s, r, c, d) => discoverTaxPayrollModule(s, r, c, d),
  obe_uncategorized: (s, r, c) => discoverObeUncategorizedModule(s, r, c),
};

export async function discoverModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string,
  module: CleanupModule,
  periodLockDate: string
): Promise<{ proposed: number }> {
  await service
    .from("cleanup_run_modules")
    .update({ status: "discovering", started_at: new Date().toISOString() } as any)
    .eq("run_id", runId)
    .eq("module", module);

  const result = await DISCOVERERS[module](service, runId, clientLinkId, periodLockDate);
  return result;
}
