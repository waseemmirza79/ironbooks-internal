import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import { Loader2, AlertCircle, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { ReviewClient } from "./review-client";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: job } = await supabase
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", id)
    .single();

  if (!job) notFound();

  const { data: actions } = await supabase
    .from("coa_actions")
    .select("*")
    .eq("job_id", id)
    .order("sort_order");

  const clientLink = (job as any).client_links;

  // ============ FAILED — surface the error ============
  if (job.status === "failed") {
    return (
      <AppShell>
        <TopBar
          title={`Analysis Failed — ${clientLink?.client_name || "Client"}`}
          subtitle="Claude or QuickBooks returned an error during analysis"
        />
        <div className="px-8 py-8 max-w-3xl">
          <div className="rounded-xl bg-red-50 border border-red-200 p-6 mb-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertCircle size={24} className="text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-base text-red-900 mb-1">
                  The analysis run failed
                </h3>
                <p className="text-sm text-red-800">
                  The error below is what came back from Claude or QuickBooks. Copy it and share it with engineering, then click retry once the issue is fixed.
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-white border border-red-200 p-4 mb-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-red-700 mb-1">
                Error message
              </div>
              <pre className="text-xs text-red-900 whitespace-pre-wrap break-words font-mono">
                {job.error_message || "(no error message recorded — check Vercel function logs)"}
              </pre>
            </div>
            <div className="text-xs text-red-700">
              <div><span className="font-semibold">Job ID:</span> {job.id}</div>
              <div><span className="font-semibold">Client:</span> {clientLink?.client_name}</div>
              <div><span className="font-semibold">Failed at:</span> {job.updated_at}</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <form action={`/api/jobs/${id}/analyze`} method="POST">
              <button
                type="submit"
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
              >
                <RefreshCcw size={14} />
                Retry Analysis
              </button>
            </form>
            <Link
              href="/jobs/new"
              className="inline-flex items-center gap-2 bg-white border border-gray-200 hover:bg-gray-50 text-navy text-sm font-semibold px-4 py-2 rounded-lg"
            >
              Start over with a different client
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  // ============ STILL ANALYZING — auto-refresh ============
  if (job.status === "draft" || !job.ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`Analyzing ${clientLink?.client_name}`}
          subtitle="Claude is reviewing the COA against the Ironbooks Master template..."
        />
        <div className="px-8 py-12 flex flex-col items-center">
          <Loader2 size={48} className="animate-spin text-teal mb-4" />
          <p className="text-sm text-ink-slate">
            This usually takes 20-40 seconds. Page will auto-refresh.
          </p>
          <p className="text-xs text-ink-light mt-2">
            Job ID: {job.id}
          </p>
          <meta httpEquiv="refresh" content="5" />
        </div>
      </AppShell>
    );
  }

  // Fetch master COA leaf accounts for the job's jurisdiction + industry.
  // Falls back to no-industry filter if Migration 7 hasn't run yet.
  //
  // Uses the SERVICE-ROLE client deliberately: master_coa is global
  // reference data (the Ironbooks-curated chart-of-accounts template),
  // not client-scoped. Its RLS policy gates SELECT behind is_team_member(),
  // which can return false in server-component contexts where auth.uid()
  // isn't reliably populated — leaving the Map-to-Master dropdown empty
  // for legitimately authenticated bookkeepers. Bypassing RLS here is
  // intentional and safe: every staff user who can reach this page should
  // see the full master COA.
  const jurisdiction = (clientLink?.jurisdiction as string) || 'US';
  const industry = ((clientLink as any)?.industry as string) || 'painters';
  const refData = createServiceSupabase();

  let { data: masterAccounts } = await refData
    .from("master_coa")
    .select("account_name, parent_account_name, is_parent, section, sort_order")
    .eq("jurisdiction", jurisdiction)
    .eq("industry", industry)
    .eq("is_parent", false)
    .order("sort_order");
  // Fallbacks for missing industry rows or pre-Migration-7 state
  if ((masterAccounts || []).length === 0 && industry !== "painters") {
    const painters = await refData
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, section, sort_order")
      .eq("jurisdiction", jurisdiction)
      .eq("industry", "painters")
      .eq("is_parent", false)
      .order("sort_order");
    masterAccounts = painters.data;
  }
  if ((masterAccounts || []).length === 0) {
    const noFilter = await refData
      .from("master_coa")
      .select("account_name, parent_account_name, is_parent, section, sort_order")
      .eq("jurisdiction", jurisdiction)
      .eq("is_parent", false)
      .order("sort_order");
    masterAccounts = noFilter.data;
  }

  // ============ DONE — show review UI ============
  return (
    <AppShell>
      <TopBar
        title={`COA Review — ${clientLink?.client_name}`}
        subtitle={`${actions?.length || 0} actions identified by AI`}
      />
      <WorkflowStepper currentStep="coa" currentState="active" clientLinkId={clientLink?.id} />
      <div className="px-8 py-6">
        <ReviewClient
          jobId={id}
          clientLink={clientLink}
          initialActions={actions || []}
          masterAccounts={masterAccounts || []}
        />
      </div>
    </AppShell>
  );
}
