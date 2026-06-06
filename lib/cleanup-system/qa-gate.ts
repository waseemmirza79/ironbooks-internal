/**
 * QA Gate — automated clean-check before completion.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface QACheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface QAGateResult {
  passed: boolean;
  checks: QACheck[];
}

export async function runQAGate(
  service: SupabaseClient,
  runId: string,
  clientLinkId: string
): Promise<QAGateResult> {
  const checks: QACheck[] = [];

  // Load latest health score for this run
  const { data: healthScore } = await service
    .from("bs_health_scores")
    .select("account_grades, overall_grade")
    .eq("run_id", runId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const grades = ((healthScore as any)?.account_grades || []) as Array<{
    account_name: string;
    grade: string;
    issue: string;
  }>;

  // OBE = 0
  const obeIssues = grades.filter((g) =>
    /opening\s*balance\s*equity/i.test(g.account_name) && g.grade !== "green"
  );
  checks.push({
    id: "obe_zero",
    label: "Opening Balance Equity = 0",
    passed: obeIssues.length === 0,
    detail: obeIssues.length
      ? `${obeIssues.length} OBE issue(s) remain`
      : "OBE is zero or not present",
  });

  // UF = 0
  const ufIssues = grades.filter((g) =>
    /undeposited\s*funds/i.test(g.account_name) && g.grade !== "green"
  );
  checks.push({
    id: "uf_zero",
    label: "Undeposited Funds = 0",
    passed: ufIssues.length === 0,
    detail: ufIssues.length
      ? `UF balance remains: ${ufIssues.map((u) => u.issue).join("; ")}`
      : "UF is zero or not present",
  });

  // No uncategorized balances
  const uncatIssues = grades.filter((g) =>
    /uncategoriz|ask\s*my\s*accountant|suspense|plug/i.test(g.account_name) &&
    g.grade !== "green"
  );
  checks.push({
    id: "no_uncat",
    label: "No uncategorized/plug account balances",
    passed: uncatIssues.length === 0,
    detail: uncatIssues.length
      ? `${uncatIssues.length} uncategorized account(s) have balances`
      : "All plug accounts clear",
  });

  // No unexplained negatives on bank/CC
  const negBank = grades.filter((g) =>
    g.issue?.includes("Negative") && g.grade === "red"
  );
  checks.push({
    id: "no_neg_bank",
    label: "No unexplained negative bank/CC balances",
    passed: negBank.length === 0,
    detail: negBank.length
      ? negBank.map((n) => n.issue).join("; ")
      : "No negative bank/CC balances",
  });

  // All CPA flags cleared
  const { data: openFlags } = await service
    .from("cpa_flags")
    .select("id, description")
    .eq("run_id", runId)
    .eq("status", "open");
  checks.push({
    id: "cpa_flags_cleared",
    label: "All CPA flags signed off",
    passed: !openFlags || openFlags.length === 0,
    detail: openFlags?.length
      ? `${openFlags.length} CPA flag(s) still open`
      : "No open CPA flags",
  });

  // All modules complete or skipped
  const { data: modules } = await service
    .from("cleanup_run_modules")
    .select("module, status")
    .eq("run_id", runId);
  const incomplete = (modules || []).filter(
    (m: any) => !["complete", "skipped"].includes(m.status)
  );
  checks.push({
    id: "modules_complete",
    label: "All cleanup modules complete",
    passed: incomplete.length === 0,
    detail: incomplete.length
      ? `Incomplete: ${incomplete.map((m: any) => m.module).join(", ")}`
      : "All modules done",
  });

  // No pending approved-but-unexecuted entries
  const { count: pendingExec } = await service
    .from("proposed_entries")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("decision", "approved")
    .eq("executed", false);
  checks.push({
    id: "no_pending_exec",
    label: "All approved entries executed",
    passed: (pendingExec || 0) === 0,
    detail: pendingExec
      ? `${pendingExec} approved entries not yet executed`
      : "All approved entries posted",
  });

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

export async function saveQAGateResult(
  service: SupabaseClient,
  runId: string,
  result: QAGateResult
): Promise<void> {
  const update: Record<string, unknown> = {
    qa_results: result,
    updated_at: new Date().toISOString(),
  };
  if (result.passed) {
    update.qa_passed_at = new Date().toISOString();
  }
  await service.from("cleanup_runs").update(update as any).eq("id", runId);
}
