import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { RevenueCheckClient } from "./revenue-check-client";

export const dynamic = "force-dynamic";

/**
 * /revenue-check/[client_id] — Step 3 of the cleanup wizard: Revenue Check.
 *
 * Verifies revenue isn't double-counted before bank rules lock mappings in:
 * CRM-pushed invoices recognizing as cash-basis income while the bank deposits
 * paying them are ALSO categorized to revenue (the Dominion Painters pattern).
 * The date range defaults to the client's latest reclass job (the cleanup
 * window) and can be widened for historical cleanups so old duplicate
 * invoices surface too.
 *
 * Read-only against QBO. Seniors can flip the client to cash-deposits-only
 * revenue right here; bookkeepers see the evidence and escalate.
 */
export default async function RevenueCheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ client_id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { client_id: clientLinkId } = await params;
  const { job: jobId } = await searchParams;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead", "bookkeeper"].includes(role)) redirect("/today");

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .single();
  if (!client) redirect("/clients");

  // Default range = the cleanup job's own window (the job param when we came
  // from reclass execute, else the client's latest full-categorization job).
  let jobRange: { start: string; end: string } | null = null;
  {
    let q = (service as any)
      .from("reclass_jobs")
      .select("id, date_range_start, date_range_end, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (jobId) q = (service as any).from("reclass_jobs").select("id, date_range_start, date_range_end").eq("id", jobId).limit(1);
    const { data: jobs } = await q;
    const j: any = (jobs as any[])?.[0];
    if (j?.date_range_start && j?.date_range_end) {
      jobRange = { start: String(j.date_range_start).slice(0, 10), end: String(j.date_range_end).slice(0, 10) };
    }
  }

  return (
    <AppShell>
      <TopBar title={`Revenue Check: ${(client as any).client_name}`} subtitle="Duplicate invoice revenue" />
      <WorkflowStepper
        currentStep="revenue"
        currentState="active"
        completedSteps={["coa", "reclass"]}
        clientLinkId={clientLinkId}
      />
      <div className="px-8 py-6 max-w-5xl">
        <RevenueCheckClient
          clientLinkId={clientLinkId}
          clientName={(client as any).client_name}
          initialMode={(client as any).revenue_recognition_mode === "deposits_only" ? "deposits_only" : "standard"}
          isSenior={["admin", "lead"].includes(role)}
          jobRange={jobRange}
          nextHref={jobId ? `/reclass/${jobId}/bank-rules` : `/rules/new?client=${clientLinkId}`}
        />
      </div>
    </AppShell>
  );
}
