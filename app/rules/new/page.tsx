import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewRulesForm } from "./new-form";

export default async function NewRulesPage() {
  const supabase = await createServerSupabase();

  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .order("client_name");

  // Show recent rule discovery jobs
  const { data: recentJobs } = await supabase
    .from("rule_discovery_jobs")
    .select("*, client_links(client_name)")
    .order("created_at", { ascending: false })
    .limit(5);

  return (
    <AppShell>
      <TopBar
        title="New Bank Rules Discovery"
        subtitle="Auto-generate QBO bank feed rules from transaction history"
      />
      <WorkflowStepper currentStep="rules" currentState="active" completedSteps={["coa", "reclass", "stripe"]} />
      <div className="px-8 py-6 max-w-3xl">
        <NewRulesForm clientLinks={clientLinks || []} recentJobs={recentJobs || []} />
      </div>
    </AppShell>
  );
}
