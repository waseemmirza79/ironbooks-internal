import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BsCleanupPicker } from "./picker-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/cleanup
 *
 * Standalone entry for the guided BS cleanup wizard (pilot). Sidebar tab
 * routes here; bookkeeper picks a client and lands on
 * /balance-sheet/[id]/cleanup. Not yet wired into the 5-step Account Cleanup
 * stepper — intentional so we can test on real clients in production first.
 */
export default async function BsCleanupPickerPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes((profile as any).role)) {
    redirect("/dashboard");
  }

  const service = createServiceSupabase();

  // Pull QBO connection signals alongside the client list so we can
  // surface a green/red dot per row. Three signals matter:
  //   1. qbo_realm_id present → SNAP knows where to send API calls
  //   2. qbo_refresh_token present → SNAP can refresh the access token
  //   3. NOT in the latest dead-token probe → most recent probe confirmed
  //      the refresh actually worked (or hasn't been probed recently)
  const { data: clientLinks } = await service
    .from("client_links")
    .select(
      "id, client_name, jurisdiction, state_province, cleanup_completed_at, qbo_realm_id, qbo_refresh_token"
    )
    .eq("is_active", true)
    .order("client_name");

  const { data: activeRuns } = await service
    .from("cleanup_runs")
    .select("id, client_link_id, status")
    .in("status", ["discovering", "reviewing", "executing"]);

  // Find the most recent qbo_token_health_probe audit_log entry to mark
  // confirmed-dead clients red. If the most recent probe is older than
  // 7 days OR no probe has ever run, we can't trust the dead list — fall
  // back to "has refresh token = green" only.
  const { data: latestProbe } = await service
    .from("audit_log")
    .select("request_payload, occurred_at")
    .eq("event_type", "qbo_token_health_probe")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const probeAgeHours = latestProbe
    ? (Date.now() - new Date((latestProbe as any).occurred_at).getTime()) /
      (1000 * 60 * 60)
    : null;
  const probeStillFresh = probeAgeHours != null && probeAgeHours < 24 * 7;
  // The probe payload stores dead clients as { dead_clients: [{ client: name, code }] }
  // — match by name since we don't have the realm_id in that summary.
  const deadClientNames = new Set<string>();
  if (probeStillFresh) {
    const dead = ((latestProbe as any)?.request_payload?.dead_clients || []) as Array<{ client?: string }>;
    for (const d of dead) {
      if (d?.client) deadClientNames.add(d.client);
    }
  }

  // Build the trimmed list the client gets — boolean qboHealthy keeps
  // the picker simple (no need to ship raw tokens to the browser).
  const enrichedClients = ((clientLinks as any[]) || []).map((c) => {
    const hasTokens = !!c.qbo_realm_id && !!c.qbo_refresh_token;
    const confirmedDead = probeStillFresh && deadClientNames.has(c.client_name);
    return {
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction,
      state_province: c.state_province,
      cleanup_completed_at: c.cleanup_completed_at,
      qbo_status: !hasTokens
        ? ("not_connected" as const)
        : confirmedDead
        ? ("dead" as const)
        : ("connected" as const),
    };
  });

  return (
    <AppShell>
      <TopBar
        title="BS Cleanup"
        subtitle="Pilot · guided balance sheet reconciliation — pick a client to start or continue"
      />
      <div className="px-8 py-6 max-w-3xl">
        <BsCleanupPicker
          clientLinks={enrichedClients}
          activeRuns={(activeRuns as any[]) || []}
          probeAgeHours={probeAgeHours}
        />
      </div>
    </AppShell>
  );
}
