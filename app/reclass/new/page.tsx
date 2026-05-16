import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewReclassForm } from "./form";

export default async function NewReclassPage() {
  const supabase = await createServerSupabase();

  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name")
    .eq("is_active", true)
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
