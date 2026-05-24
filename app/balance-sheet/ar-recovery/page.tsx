import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { ArRecoveryPicker } from "./picker-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/ar-recovery
 *
 * Cross-client picker for the A/R Recovery toolkit (UF Audit + UF→A/R matcher
 * + Uncategorized Income Recovery). Sidebar entry under Advanced routes here;
 * bookkeeper picks a client and lands on /balance-sheet/[id]/ar-recovery.
 */
export default async function ArRecoveryPickerPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: clientLinks } = await supabase
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, cleanup_completed_at, assigned_bookkeeper_id")
    .eq("is_active", true)
    .order("client_name");

  return (
    <AppShell>
      <TopBar
        title="A/R Recovery"
        subtitle="UF Audit · UF → A/R matcher · Uncategorized Income Recovery — pick a client to open the toolkit"
      />
      <div className="px-8 py-6 max-w-3xl">
        <ArRecoveryPicker clientLinks={(clientLinks as any[]) || []} />
      </div>
    </AppShell>
  );
}
