import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { AuditLogViewer } from "./audit-log-viewer";

export default async function AuditPage() {
  const supabase = await createServerSupabase();

  const [
    { data: initialEvents },
    { data: users },
    { data: clients },
  ] = await Promise.all([
    supabase.from("recent_activity_feed").select("*").limit(200),
    supabase.from("users").select("id, full_name").eq("is_active", true).order("full_name"),
    supabase.from("client_links").select("id, client_name").eq("is_active", true).order("client_name"),
  ]);

  return (
    <AppShell>
      <TopBar
        title="Audit Log"
        subtitle="Search all actions by user, client, date, or event type — for compliance review"
      />
      <div className="px-8 py-6">
        <AuditLogViewer
          initialEvents={initialEvents || []}
          users={users || []}
          clients={clients || []}
        />
      </div>
    </AppShell>
  );
}
