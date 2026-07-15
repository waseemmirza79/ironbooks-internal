import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BankRulesFleetClient } from "./bank-rules-fleet-client";

export const dynamic = "force-dynamic";

/**
 * /admin/bank-rules — fleet-wide bank-rule status. Which clients still need
 * SNAP's rules imported into QBO (+ their old rules cleared), with a one-click
 * .xls download per client to amend and import.
 */
export default async function BankRulesFleetPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar
        title="Bank rules — fleet"
        subtitle="Which clients need SNAP rules imported to QBO (and their old rules cleared)"
      />
      <div className="px-8 py-6 max-w-4xl">
        <BankRulesFleetClient />
      </div>
    </AppShell>
  );
}
