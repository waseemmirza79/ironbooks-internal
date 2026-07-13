import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { VendorRemediationClient } from "./remediation-client";

export const dynamic = "force-dynamic";

/**
 * /admin/vendor-remediation — fleet re-categorization under the REVIEWED
 * vendor rules (2026-07 KB rebuild).
 *
 * Scan is read-only. The review screen shows, per client and per
 * from→to account transition, exactly what would change — nothing touches
 * QuickBooks until the admin approves a client's selections and clicks Apply.
 * Closed periods and human-overridden lines are never modified.
 */
export default async function VendorRemediationPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  return (
    <AppShell>
      <TopBar
        title="Vendor Remediation"
        subtitle="Re-categorize past transactions under the reviewed vendor rules — verify per account, then apply per client"
      />
      <div className="px-8 py-6 max-w-6xl">
        <VendorRemediationClient />
      </div>
    </AppShell>
  );
}
