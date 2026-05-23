import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BsCoaPicker } from "./picker-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/coa
 *
 * Client picker for the Balance Sheet COA viewer. Sidebar entry under
 * Advanced routes here; the bookkeeper picks a client and gets sent to
 * /balance-sheet/[client_id]/coa.
 *
 * Static path takes Next.js routing priority over the dynamic
 * /balance-sheet/[client_id] sibling, so this loads cleanly.
 */
export default async function BsCoaPickerPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Every active client — bookkeepers should be able to inspect any
  // client's BS, even if cleanup isn't started or is already complete.
  // Sorted by name so the picker is alphabetic.
  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at, assigned_bookkeeper_id")
    .eq("is_active", true)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="Balance Sheet COA"
        subtitle="Inspect any client's BS chart of accounts — view balances, hierarchy, drill into transactions, add/rename/inactivate accounts"
      />
      <div className="px-8 py-6 max-w-3xl">
        <BsCoaPicker clientLinks={(clientLinks as any[]) || []} />
      </div>
    </AppShell>
  );
}
