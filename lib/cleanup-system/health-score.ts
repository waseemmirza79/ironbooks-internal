/**
 * Balance Sheet Health Score — diagnose and grade every BS account.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountGrade,
  CleanupModule,
  HealthGrade,
  HealthTask,
} from "./types";

const UF_PATTERNS = [/undeposited\s*funds/i, /^uf$/i];
const OBE_PATTERNS = [/opening\s*balance\s*equity/i, /^obe$/i];
const UNCAT_PATTERNS = [
  /uncategoriz/i,
  /ask\s*my\s*accountant/i,
  /suspense/i,
  /plug/i,
];

interface DiagnoseInput {
  trialBalance: Array<{ qbo_account_id: string; name: string; account_type: string; balance: number }>;
  balanceSheet: Array<{ qbo_account_id: string; name: string; account_type: string; balance: number; kind: string }>;
}

function gradeAccount(
  name: string,
  accountType: string,
  balance: number
): { grade: HealthGrade; issue: string; module: CleanupModule | null; priority: number } {
  const absBal = Math.abs(balance);

  if (UF_PATTERNS.some((p) => p.test(name)) && absBal > 0.01) {
    return {
      grade: absBal > 500 ? "red" : "yellow",
      issue: `Undeposited Funds balance $${balance.toFixed(2)}`,
      module: "undeposited_funds",
      priority: absBal > 500 ? 1 : 3,
    };
  }

  if (OBE_PATTERNS.some((p) => p.test(name)) && absBal > 0.01) {
    return {
      grade: "red",
      issue: `Opening Balance Equity $${balance.toFixed(2)} — must be zeroed`,
      module: "obe_uncategorized",
      priority: 8,
    };
  }

  if (UNCAT_PATTERNS.some((p) => p.test(name)) && absBal > 0.01) {
    return {
      grade: "yellow",
      issue: `Uncategorized/plug account balance $${balance.toFixed(2)}`,
      module: "obe_uncategorized",
      priority: 7,
    };
  }

  if (accountType === "Accounts Receivable" && absBal > 1000) {
    return {
      grade: "yellow",
      issue: `A/R balance $${balance.toFixed(2)} — verify aging`,
      module: "accounts_receivable",
      priority: 4,
    };
  }

  if (accountType === "Accounts Payable" && absBal > 500) {
    return {
      grade: "yellow",
      issue: `A/P balance $${balance.toFixed(2)} — verify open bills`,
      module: "accounts_payable",
      priority: 5,
    };
  }

  if (
    (accountType === "Long Term Liability" || accountType === "Other Current Liability") &&
    /loan|mortgage|loc|line of credit/i.test(name) &&
    balance < 0
  ) {
    return {
      grade: "red",
      issue: `Negative loan balance $${balance.toFixed(2)}`,
      module: "loans",
      priority: 6,
    };
  }

  if (/sales\s*tax|gst|hst|pst/i.test(name) && absBal > 100) {
    return {
      grade: "yellow",
      issue: `Sales tax liability $${balance.toFixed(2)} — tie to filed amounts`,
      module: "tax_payroll",
      priority: 6,
    };
  }

  if (/payroll|wagepoint|gusto|remittance/i.test(name) && absBal > 100) {
    return {
      grade: "yellow",
      issue: `Payroll liability $${balance.toFixed(2)}`,
      module: "tax_payroll",
      priority: 6,
    };
  }

  if (/draw|distribution|shareholder|owner/i.test(name) && absBal > 5000) {
    return {
      grade: "yellow",
      issue: `Owner/shareholder account $${balance.toFixed(2)} — verify classification`,
      module: "shareholder_draws",
      priority: 5,
    };
  }

  if (balance < -0.01 && ["Bank", "Credit Card"].includes(accountType)) {
    return {
      grade: "red",
      issue: `Negative ${accountType} balance $${balance.toFixed(2)}`,
      module: "bank_recon",
      priority: 2,
    };
  }

  return { grade: "green", issue: "", module: null, priority: 99 };
}

export function computeHealthScore(input: DiagnoseInput): {
  overallScore: number;
  overallGrade: HealthGrade;
  accountGrades: AccountGrade[];
  taskList: HealthTask[];
} {
  const accountGrades: AccountGrade[] = [];
  const seen = new Set<string>();

  for (const acct of input.trialBalance) {
    if (seen.has(acct.qbo_account_id)) continue;
    seen.add(acct.qbo_account_id);

    const { grade, issue, module, priority } = gradeAccount(
      acct.name,
      acct.account_type,
      acct.balance
    );

    if (grade !== "green") {
      accountGrades.push({
        qbo_account_id: acct.qbo_account_id,
        account_name: acct.name,
        account_type: acct.account_type,
        balance: acct.balance,
        grade,
        issue,
        module,
        priority,
      });
    }
  }

  // Bank accounts from balance sheet that may not appear in trial balance issues
  for (const acct of input.balanceSheet) {
    if (seen.has(acct.qbo_account_id)) continue;
    const { grade, issue, module, priority } = gradeAccount(
      acct.name,
      acct.account_type,
      acct.balance
    );
    if (grade !== "green") {
      accountGrades.push({
        qbo_account_id: acct.qbo_account_id,
        account_name: acct.name,
        account_type: acct.account_type,
        balance: acct.balance,
        grade,
        issue,
        module,
        priority,
      });
    }
  }

  accountGrades.sort((a, b) => a.priority - b.priority);

  const redCount = accountGrades.filter((a) => a.grade === "red").length;
  const yellowCount = accountGrades.filter((a) => a.grade === "yellow").length;
  const totalIssues = accountGrades.length;

  let overallScore = 100;
  overallScore -= redCount * 15;
  overallScore -= yellowCount * 5;
  overallScore = Math.max(0, Math.min(100, overallScore));

  let overallGrade: HealthGrade = "green";
  if (redCount > 0) overallGrade = "red";
  else if (yellowCount > 0 || totalIssues > 0) overallGrade = "yellow";

  const taskList: HealthTask[] = accountGrades.slice(0, 20).map((a, i) => ({
    id: `task-${a.qbo_account_id}`,
    title: a.issue,
    description: `Fix via ${a.module || "review"} module`,
    module: a.module || "bank_recon",
    grade: a.grade,
    priority: a.priority,
  }));

  return { overallScore, overallGrade, accountGrades, taskList };
}

export async function saveHealthScore(
  service: SupabaseClient,
  clientLinkId: string,
  runId: string,
  snapshotId: string,
  input: DiagnoseInput
): Promise<string> {
  const result = computeHealthScore(input);

  const { data, error } = await service
    .from("bs_health_scores")
    .insert({
      client_link_id: clientLinkId,
      run_id: runId,
      snapshot_id: snapshotId,
      overall_score: result.overallScore,
      overall_grade: result.overallGrade,
      account_grades: result.accountGrades,
      task_list: result.taskList,
    } as any)
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save health score: ${error.message}`);
  return data.id;
}
