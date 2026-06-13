import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { UsersManagement } from "./users-management";

export default async function AdminUsersPage() {
  const supabase = await createServerSupabase();

  const { data: users } = await supabase
    .from("user_activity_stats")
    .select("*")
    .order("created_at", { ascending: true });

  return (
    <AppShell>
      <TopBar
        title="Team Management"
        subtitle={`${users?.length || 0} team members — manage access + roles`}
      />
      <div className="px-8 py-6">
        <UsersManagement initialUsers={users || []} />
      </div>
    </AppShell>
  );
}
