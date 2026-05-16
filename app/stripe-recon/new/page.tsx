import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { NewStripeReconForm } from "./form";

export default async function NewStripeReconPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: clientLinks } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name")
    .eq("is_active", true)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Stripe AR Reconciliation"
        subtitle="Match Stripe deposits to customer invoices · calculate fees + sales tax"
      />
      <WorkflowStepper currentStep="stripe" currentState="active" completedSteps={["coa", "reclass"]} />
      <div className="px-8 py-6 max-w-3xl">
        <NewStripeReconForm clientLinks={clientLinks || []} />
      </div>
    </AppShell>
  );
}
