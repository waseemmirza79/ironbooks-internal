import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { redirect } from "next/navigation";
import { BankRulesFromReclassClient } from "./bank-rules-client";

// Account types eligible to be a bank-rule target. P&L types are the
// dominant case but Equity belongs here too — Owner Draws / Owner
// Contributions are legitimate categorization destinations (especially
// for commingled accounts where the client paid personal expenses
// out of the business). Excluding Equity means Owner Draw never
// appears in the dropdown even when the reclass step routed
// transactions there.
const RECLASS_TARGET_TYPES_NORMALIZED = new Set([
  "income",
  "otherincome",
  "expense",
  "otherexpense",
  "costofgoodssold",
  "equity",
]);

function isReclassTargetType(t: string | null | undefined): boolean {
  if (!t) return false;
  return RECLASS_TARGET_TYPES_NORMALIZED.has(t.toLowerCase().replace(/\s+/g, ""));
}

export default async function BankRulesFromReclassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, workflow, status, date_range_start, date_range_end")
    .eq("id", id)
    .single();

  if (!job) {
    return (
      <AppShell>
        <TopBar title="Job Not Found" />
        <div className="px-8 py-6">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg">Reclass job not found.</div>
        </div>
      </AppShell>
    );
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("client_name, qbo_realm_id")
    .eq("id", job.client_link_id)
    .single();

  const clientName = (clientLink as any)?.client_name || "Client";
  const qboRealmId = (clientLink as any)?.qbo_realm_id;

  // Fetch live reclass-target accounts (P&L + Equity) so the bookkeeper
  // can override any AI-picked target. Fail-soft: if QBO is unreachable,
  // dropdowns get an empty list and the row shows the proposed account
  // as a read-only label.
  let availablePnLAccounts: Array<{ id: string; name: string; type: string }> = [];
  if (qboRealmId) {
    try {
      const accessToken = await getValidToken(job.client_link_id, service as any);
      const allAccounts = await fetchAllAccounts(qboRealmId, accessToken);
      const pnl = allAccounts
        .filter((a) => a.Active !== false && isReclassTargetType(a.AccountType))
        .map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType }));
      console.log(
        `[bank-rules ${id}] QBO returned ${allAccounts.length} accounts total, ${pnl.length} reclass-target active. Account types: ${[...new Set(allAccounts.map((a) => a.AccountType))].join(", ")}`
      );
      availablePnLAccounts = pnl.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      console.warn(`[bank-rules ${id}] Could not fetch reclass-target accounts:`, err.message);
    }
  }

  // Include every decision that came in with a target — even
  // 'flagged' rows (low AI confidence) and 'ask_client' rows when the
  // bookkeeper has overridden a target. The row-level `target_name`
  // filter below drops anything that doesn't have a destination. The
  // bookkeeper sees flagged rows as candidates and can deselect them
  // if they don't want a permanent bank rule.
  //
  // Before: only auto_approve / approved / needs_review made it here,
  // which meant contractor e-transfers and other low-confidence
  // vendors disappeared from this screen entirely.
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount, decision"
    )
    .eq("reclass_job_id", id)
    .in("decision", ["auto_approve", "approved", "needs_review", "flagged", "ask_client"])
    .not("vendor_name", "is", null);

  type ReclassRow = {
    vendor_name: string | null;
    vendor_pattern_normalized: string | null;
    to_account_id: string;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
    transaction_amount: number | null;
    decision: string;
  };

  const groupMap = new Map<
    string,
    {
      vendorDisplay: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
    }
  >();

  for (const row of (rows || []) as ReclassRow[]) {
    const groupKey = row.vendor_pattern_normalized || row.vendor_name || "";
    if (!groupKey) continue;

    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (!targetName) continue;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        vendorDisplay: row.vendor_name || groupKey,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
      });
    }

    const group = groupMap.get(groupKey)!;
    group.txCount += 1;
    group.totalAmount += row.transaction_amount || 0;

    const existing = group.targetCounts.get(targetId);
    if (existing) {
      existing.count += 1;
    } else {
      group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

  // Pull existing bank rules for this client so we can exclude vendors that
  // already have a rule pushed to QBO — no point re-creating the same rule.
  // Vendors with a local-only bank_rules row (pushed_to_qbo=false) DO stay
  // visible so the bookkeeper can re-push them.
  const { data: existingRules } = await service
    .from("bank_rules")
    .select("vendor_pattern, pushed_to_qbo")
    .eq("client_link_id", job.client_link_id);

  function normalizePattern(s: string): string {
    return s.toUpperCase().replace(/\s+/g, " ").trim();
  }
  const alreadyInQbo = new Set<string>();
  for (const r of (existingRules || []) as Array<{ vendor_pattern: string | null; pushed_to_qbo: boolean | null }>) {
    if (r.pushed_to_qbo && r.vendor_pattern) {
      alreadyInQbo.add(normalizePattern(r.vendor_pattern));
    }
  }

  const proposedRules = Array.from(groupMap.entries())
    .map(([vendorPattern, group]) => {
      let bestTarget = { id: "", name: "" };
      let bestCount = 0;
      for (const t of group.targetCounts.values()) {
        if (t.count > bestCount) {
          bestCount = t.count;
          bestTarget = { id: t.id, name: t.name };
        }
      }
      if (!bestTarget.name) return null;
      // Skip vendors that already have a rule pushed to QBO.
      if (alreadyInQbo.has(normalizePattern(vendorPattern))) return null;
      return {
        vendorPattern,
        vendorDisplay: group.vendorDisplay,
        targetAccountId: bestTarget.id,
        targetAccountName: bestTarget.name,
        txCount: group.txCount,
        totalAmount: group.totalAmount,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b!.txCount - a!.txCount) as Array<{
    vendorPattern: string;
    vendorDisplay: string;
    targetAccountId: string;
    targetAccountName: string;
    txCount: number;
    totalAmount: number;
  }>;
  console.log(
    `[bank-rules ${id}] Proposed: ${proposedRules.length} (excluded ${alreadyInQbo.size} already pushed to QBO)`
  );

  // Build the FINAL dropdown list: live QBO P&L accounts UNION the targets the
  // AI/bookkeeper picked in this job's rows. Catches accounts the AI chose but
  // that aren't (or no longer are) in the live QBO P&L list — without this,
  // those accounts vanish from the dropdown and the bookkeeper sees a smaller
  // list than what was actually used.
  const dropdownById = new Map<string, { id: string; name: string; type: string }>();
  for (const a of availablePnLAccounts) {
    dropdownById.set(a.id, a);
  }
  for (const rule of proposedRules) {
    if (!rule.targetAccountId) continue;
    if (dropdownById.has(rule.targetAccountId)) continue;
    dropdownById.set(rule.targetAccountId, {
      id: rule.targetAccountId,
      name: rule.targetAccountName,
      type: "(from classification)",
    });
  }
  const availableAccountsForDropdown = Array.from(dropdownById.values()).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  console.log(
    `[bank-rules ${id}] Dropdown final: ${availableAccountsForDropdown.length} accounts (${availablePnLAccounts.length} live QBO P&L + ${availableAccountsForDropdown.length - availablePnLAccounts.length} from classification)`
  );

  return (
    <AppShell>
      <TopBar
        title={`Bank Rules: ${clientName}`}
        subtitle="From Reclassification"
      />
      <WorkflowStepper
        currentStep="rules"
        currentState="active"
        completedSteps={["coa", "reclass"]}
        clientLinkId={job.client_link_id}
      />
      <div className="px-8 py-6 max-w-4xl">
        <BankRulesFromReclassClient
          reclassJobId={id}
          clientLinkId={job.client_link_id}
          clientName={clientName}
          proposedRules={proposedRules}
          availableAccounts={availableAccountsForDropdown}
          cleanupRangeStart={(job as any).date_range_start || null}
          cleanupRangeEnd={(job as any).date_range_end || null}
        />
      </div>
    </AppShell>
  );
}
