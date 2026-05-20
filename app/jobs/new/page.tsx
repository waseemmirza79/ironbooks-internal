import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { NewJobForm } from "./form";

export default async function NewJobPage() {
  const supabase = await createServerSupabase();

  // Hide cleanup-completed AND in-review clients from the select-client
  // list. Completed = closed cycle, shown in /clients Completed Accounts
  // with a Reopen button. In Review = bookkeeper submitted, awaiting
  // senior — withdraw from /clients In Review section if more work
  // needed.
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .is("cleanup_completed_at", null)
    .is("cleanup_review_state", null)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="New COA Cleanup Job"
        subtitle="Select the client you want to clean up"
      />
      <WorkflowStepper currentStep="coa" currentState="active" />
      <div className="px-8 py-6 max-w-4xl">
        <NewJobForm clientLinks={clientLinks || []} />
      </div>
    </AppShell>
  );
}
