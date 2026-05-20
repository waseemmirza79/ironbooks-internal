import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { KanbanClient } from "./kanban-client";

export default async function KanbanPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  const service = createServiceSupabase();

  const [profileRes, bookkeepersRes] = await Promise.all([
    user
      ? service.from("users").select("role, full_name").eq("id", user.id).single()
      : Promise.resolve({ data: null }),
    service
      .from("users")
      .select("id, full_name, avatar_url")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name"),
  ]);

  const profile = profileRes.data;
  const canEdit = profile ? ["admin", "lead"].includes(profile.role) : false;
  const bookkeepers = bookkeepersRes.data || [];

  return (
    <AppShell>
      <TopBar
        title="Workflow"
        subtitle="Track all clients through onboarding and month-over-month bookkeeping"
      />
      <div className="px-6 py-6">
        <KanbanClient
          bookkeepers={bookkeepers}
          canEdit={canEdit}
          currentUserId={user?.id || ""}
        />
      </div>
    </AppShell>
  );
}
