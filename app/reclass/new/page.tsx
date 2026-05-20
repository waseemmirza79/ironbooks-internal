import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewReclassForm } from "./form";

export default async function NewReclassPage() {
  const supabase = await createServerSupabase();

  // Cleanup-completed AND in-review clients are hidden — completed live
  // in /clients Completed Accounts (with a Reopen button); in-review
  // live in the In Review section (with a Withdraw button if more work
  // is needed before approval).
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name")
    .eq("is_active", true)
    .is("cleanup_completed_at", null)
    .is("cleanup_review_state", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="New Reclassification Job"
        subtitle="Categorize transactions against the new COA"
      />
      <WorkflowStepper currentStep="reclass" currentState="active" completedSteps={["coa"]} />
      <div className="px-8 py-6 max-w-4xl">
        <NewReclassForm clientLinks={clientLinks || []} />
      </div>
    </AppShell>
  );
}
