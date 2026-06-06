/**
 * Module discovery — wraps existing BS modules under the orchestrator.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createProposedEntry } from "./proposed-entries";
import { createCpaFlag, requiresCpaFlag } from "./cpa-flags";
import type { CleanupModule } from "./types";
import { discoverUndepositedFundsModule } from "./uf-discovery";
import {
  discoverAccountsReceivableModule,
  type ArDiscoverOptions,
} from "./ar-discovery";

export async function discoverBankReconModule(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<{ proposed: number }> {
  // Link any existing per-account recon rows from the legacy BS landing flow.
  await service
    .from("bank_recon_jobs")
    .update({ cleanup_run_id: runId } as any)
    .eq("client_link_id", clientLinkId)
    .is("cleanup_run_id", null);

  const { data: recons } = await service
    .from("bank_recon_jobs")
    .select("*")
    .eq("client_link_id", clientLinkId)
    .or(`cleanup_run_id.eq.${runId},cleanup_run_id.is.null`);

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
  (
    service: SupabaseClient,
    runId: string,
    clientLinkId: string,
    periodLockDate: string,
    options?: ArDiscoverOptions
  ) => Promise<{ proposed: number }>
> = {
  bank_recon: (s, r, c) => discoverBankReconModule(s, r, c),
  undeposited_funds: (s, r, c, d) => discoverUndepositedFundsModule(s, r, c, d),
  accounts_receivable: (s, r, c, d, o) =>
    discoverAccountsReceivableModule(s, r, c, d, o || {}),
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
  periodLockDate: string,
  options?: ArDiscoverOptions
): Promise<{ proposed: number }> {
  await service
    .from("cleanup_run_modules")
    .update({ status: "discovering", started_at: new Date().toISOString() } as any)
    .eq("run_id", runId)
    .eq("module", module);

  const result = await DISCOVERERS[module](
    service,
    runId,
    clientLinkId,
    periodLockDate,
    options
  );
  return result;
}
