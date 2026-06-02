import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { redirect } from "next/navigation";
import { BankRulesFromReclassClient } from "./bank-rules-client";

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

  // Fetch every active account in the COA so the bookkeeper can map a
  // vendor to anything they want. Previously we filtered to P&L + Equity
  // only, which dropped Asset / Liability targets (deposit clearing, A/R
  // adjustments, contractor advances, etc.). Bookkeeper now picks freely.
  // Fail-soft: if QBO is unreachable, dropdowns get an empty list and the
  // row shows the proposed account as a read-only label.
  let availablePnLAccounts: Array<{ id: string; name: string; type: string }> = [];
  if (qboRealmId) {
    try {
      const accessToken = await getValidToken(job.client_link_id, service as any);
      const allAccounts = await fetchAllAccounts(qboRealmId, accessToken);
      const active = allAccounts
        .filter((a) => a.Active !== false)
        .map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType || "" }));
      console.log(
        `[bank-rules ${id}] QBO returned ${allAccounts.length} accounts total, ${active.length} active. Account types: ${[...new Set(allAccounts.map((a) => a.AccountType))].join(", ")}`
      );
      availablePnLAccounts = active.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: any) {
      console.warn(`[bank-rules ${id}] Could not fetch accounts:`, err.message);
    }
  }

  // Pull EVERY classification row that has a vendor name — across every
  // decision type. Goal: the bookkeeper sees one card per unique vendor
  // in this job and can opt every one of them into a permanent rule.
  // Even vendors with no AI-picked target are surfaced (with an empty
  // dropdown the bookkeeper fills in). Even 'skip' rows (already_correct
  // mappings) are pulled — those vendors are perfect rule candidates
  // because the mapping is already proven right.
  //
  // The only filter is `vendor_name IS NOT NULL` — without a vendor name
  // there's no pattern to build a rule from.
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount, decision"
    )
    .eq("reclass_job_id", id)
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

    // Count this row's target only when one exists — but still count the
    // tx itself. Groups with zero target observations still surface in
    // proposedRules with an empty target so the bookkeeper can fill it in.
    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (targetName) {
      const existing = group.targetCounts.get(targetId);
      if (existing) {
        existing.count += 1;
      } else {
        group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
      }
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

  // Build proposed rules from EVERY vendor group, including ones with no
  // AI-picked target. Rules without a target are emitted with empty
  // target_* fields — the client renders them with a "Pick target..."
  // dropdown and the bookkeeper opts them in by selecting the row AND
  // picking a target. Err on the side of more rules.
  //
  // Sort order (top-down):
  //   1. Has AI-picked target, highest tx count first
  //   2. Has AI-picked target, lower tx count
  //   3. No target yet (needs bookkeeper attention) — sorted by tx count
  let skippedAsAlreadyInQbo = 0;
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
      // Skip vendors that already have a rule pushed to QBO.
      if (alreadyInQbo.has(normalizePattern(vendorPattern))) {
        skippedAsAlreadyInQbo++;
        return null;
      }
      return {
        vendorPattern,
        vendorDisplay: group.vendorDisplay,
        targetAccountId: bestTarget.id, // "" when no AI pick
        targetAccountName: bestTarget.name, // "" when no AI pick
        txCount: group.txCount,
        totalAmount: group.totalAmount,
        hasTarget: !!bestTarget.name,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => {
      // Targeted rules first; within each group, sort by tx count desc
      if (a.hasTarget !== b.hasTarget) return a.hasTarget ? -1 : 1;
      return b.txCount - a.txCount;
    });
  const withoutTarget = proposedRules.filter((r) => !r.hasTarget).length;
  console.log(
    `[bank-rules ${id}] Proposed: ${proposedRules.length} (${withoutTarget} need bookkeeper to pick target; excluded ${skippedAsAlreadyInQbo} already pushed to QBO)`
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
