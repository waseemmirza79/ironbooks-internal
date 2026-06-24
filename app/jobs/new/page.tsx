import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { NewJobForm } from "./form";
import { buildCleanupRoster } from "@/lib/cleanup-roster";

export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // The launcher buckets every active client into 5 sections. "New cleanup"
  // (nothing started) drives the existing pick → setup flow; the other four
  // (Continue / Stripe recon / Balance Sheet / completed) are link lists.
  const service = createServiceSupabase();
  const roster = await buildCleanupRoster(service);

  return (
    <AppShell>
      <TopBar title="Account Cleanup" subtitle="Pick up where each client left off" />
      <div className="px-8 py-6 max-w-3xl">
        <NewJobForm
          clientLinks={roster.newCleanup}
          sections={{
            continueCleanup: roster.continueCleanup,
            completed: roster.completed,
            stripeRecon: roster.stripeRecon,
            bsCleanup: roster.bsCleanup,
          }}
        />
      </div>
    </AppShell>
  );
}
