import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import { LiveExecution } from "./live-execution";

export default async function ExecutePage({
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

  const clientLink = (job as any).client_links;

  return (
    <AppShell>
      <TopBar
        title={
          job.status === "complete"
            ? "Cleanup Complete"
            : job.status === "failed"
            ? "Cleanup Failed"
            : "Executing Cleanup"
        }
        subtitle={`${clientLink?.client_name} • ${clientLink?.jurisdiction} ${clientLink?.state_province || ""}`}
      />
      <div className="px-8 py-6 max-w-5xl">
        <LiveExecution
          jobId={id}
          initialStatus={job.status}
          clientName={clientLink?.client_name}
          clientLinkId={clientLink?.id}
        />
      </div>
    </AppShell>
  );
}
