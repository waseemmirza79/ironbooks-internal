import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import { Loader2 } from "lucide-react";
import { buildReclassTargetMap } from "@/lib/reclass-rule-defaults";
import { RulesReviewClient } from "./review-client";

export default async function RulesReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: job } = await supabase
    .from("rule_discovery_jobs")
    .select("*, client_links(*)")
    .eq("id", id)
    .single();

  if (!job) notFound();

  const { data: rules } = await supabase
    .from("bank_rules")
    .select("*")
    .eq("discovery_job_id", id)
    .order("transaction_count", { ascending: false });

  const clientLink = (job as any).client_links;

  // The account each vendor was reclassed to in Step 2 — used to mark which
  // rule targets came from the bookkeeper's own reclass decision (vs. a fresh
  // AI guess) and to offer a one-click "use reclass account" on older jobs.
  // Read-only here; the persisted default is seeded at discovery time.
  let reclassByVendor: Record<string, string> = {};
  if (clientLink?.id) {
    try {
      const map = await buildReclassTargetMap(createServiceSupabase() as any, clientLink.id);
      const vendorsOnPage = new Set((rules || []).map((r: any) => r.vendor_pattern));
      for (const [vendor, target] of map.entries()) {
        if (vendorsOnPage.has(vendor)) reclassByVendor[vendor] = target.name;
      }
    } catch {
      // Non-critical — the picker still works without the reclass markers.
    }
  }

  // If still analyzing
  if (!job.ai_completed_at && job.status !== "failed") {
    return (
      <AppShell>
        <TopBar
          title={`Analyzing ${clientLink?.client_name}`}
          subtitle="Pulling transactions and grouping by vendor..."
        />
        <WorkflowStepper currentStep="rules" currentState="active" completedSteps={["coa", "reclass"]} clientLinkId={clientLink?.id} />
        <div className="px-8 py-12 flex flex-col items-center">
          <Loader2 size={48} className="animate-spin text-teal mb-4" />
          <p className="text-sm text-ink-slate text-center max-w-md">
            This takes 30-60 seconds. We pull the last {job.months_analyzed || 6} months of QBO transactions,
            group by vendor, then ask Claude to map each to your Master COA.
          </p>
          <meta httpEquiv="refresh" content="5" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <TopBar
        title={`Bank Rules — ${clientLink?.client_name}`}
        subtitle={`${job.vendors_identified || 0} vendors analyzed → ${rules?.length || 0} rules suggested`}
      />
      <WorkflowStepper
        currentStep="rules"
        currentState={job.status === "complete" ? "complete" : "active"}
        completedSteps={job.status === "complete" ? ["coa", "reclass", "rules"] : ["coa", "reclass"]}
        clientLinkId={clientLink?.id}
      />
      <div className="px-8 py-6">
        <RulesReviewClient jobId={id} clientLink={clientLink} initialRules={rules || []} jobStatus={job.status} reclassByVendor={reclassByVendor} />
      </div>
    </AppShell>
  );
}
