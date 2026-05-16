import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { Loader2 } from "lucide-react";
import { StripeReconReview } from "./review-client";

export default async function StripeReconReviewPage({
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
    .from("stripe_recon_jobs")
    .select("*, client_links(client_name, jurisdiction, state_province)")
    .eq("id", id)
    .single();
  if (!job) notFound();

  const clientLink = (job as any).client_links;

  // Still discovering — show loader, auto-refresh
  if (job.status === "discovering" || !job.ai_completed_at) {
    return (
      <AppShell>
        <TopBar
          title={`Stripe Reconciliation — ${clientLink?.client_name}`}
          subtitle="Pulling Stripe deposits and matching them to invoices..."
        />
        <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass"]} />
        <div className="px-8 py-12 flex flex-col items-center">
          <Loader2 size={48} className="animate-spin text-teal mb-4" />
          <p className="text-sm text-ink-slate">
            This usually takes 20-60 seconds. Page will auto-refresh.
          </p>
          <meta httpEquiv="refresh" content="5" />
        </div>
      </AppShell>
    );
  }

  const { data: matches } = await service
    .from("stripe_recon_matches")
    .select("*")
    .eq("job_id", id)
    .order("deposit_date");

  return (
    <AppShell>
      <TopBar
        title={`Stripe Reconciliation — ${clientLink?.client_name}`}
        subtitle={`${matches?.length || 0} deposits matched`}
      />
      <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass"]} />
      <div className="px-8 py-6">
        <StripeReconReview
          job={job as any}
          matches={(matches as any) || []}
          clientLink={clientLink}
        />
      </div>
    </AppShell>
  );
}
