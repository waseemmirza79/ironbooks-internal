import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { Plus } from "lucide-react";
import { ClientsList } from "./clients-list";

export default async function ClientsPage() {
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("role, full_name").eq("id", user.id).single()
    : { data: null };

  const canEdit = profile && ["admin", "lead"].includes(profile.role);

  const [clientsRes, linksRes, bookkeepersRes] = await Promise.all([
    supabase.from("client_list_view").select("*").order("client_name"),
    // client_list_view doesn't expose double_client_name or stripe fields, pull from client_links and merge
    supabase.from("client_links").select("id, double_client_name, stripe_connection_status"),
    supabase
      .from("users")
      .select("id, full_name, avatar_url")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name"),
  ]);

  const linksData = linksRes.data || [];
  const nameById = new Map<string, string | null>(
    linksData.map((l) => [l.id, l.double_client_name ?? null])
  );
  const stripeStatusById = new Map<string, string | null>(
    linksData.map((l) => [l.id, (l as any).stripe_connection_status ?? null])
  );

  const enrichedClients = (clientsRes.data || []).map((c) => ({
    ...c,
    double_client_name: c.id ? nameById.get(c.id) ?? null : null,
    stripe_connection_status: c.id ? stripeStatusById.get(c.id) ?? null : null,
  }));

  return (
    <AppShell>
      <TopBar
        title="Clients"
        subtitle={`${enrichedClients.length} clients`}
        actions={
          <a
            href="/api/qbo/connect"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <Plus size={16} />
            Connect QuickBooks Client
          </a>
        }
      />
      <div className="px-8 py-6">
        <ClientsList
          initialClients={enrichedClients}
          bookkeepers={bookkeepersRes.data || []}
          currentUserId={user?.id || ""}
          canEdit={!!canEdit}
        />
      </div>
    </AppShell>
  );
}
