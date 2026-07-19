import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { CoaAuditClient } from "./audit-client";

export const dynamic = "force-dynamic";

/**
 * /admin/coa-audit — READ-ONLY fleet drift report: how conformant each
 * client's live QBO chart is to the master COA. Triage layer for the
 * "apply the master COA to every client" standardization phase. No writes.
 */
export default async function CoaAuditPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, email").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  // Owner-only (Mike): the multi-select batch Fix-all runner. Gated by email —
  // there's no dedicated owner role, and this is the one control that writes to
  // many clients' books at once, so it stays off for every other admin.
  const OWNER_EMAILS = new Set(["mike@paintergrowth.com"]);
  const isOwner =
    OWNER_EMAILS.has(String((actor as any)?.email || "").toLowerCase()) ||
    OWNER_EMAILS.has(String(user.email || "").toLowerCase());

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction")
    .eq("is_active", true)
    .not("qbo_realm_id", "is", null)
    .order("client_name");

  // Hydrate from the last cached scan of each client (migration 135) so the
  // fleet view loads instantly instead of re-scanning QuickBooks. Degrades to
  // "unscanned" if the table isn't there yet.
  let initialScans: Record<string, { drift: any; scannedAt: string; scannedBy: string | null }> = {};
  try {
    const { data: scans } = await (service as any)
      .from("coa_audit_scans")
      .select("client_link_id, payload, scanned_at, scanned_by_name");
    for (const s of (scans as any[]) || []) {
      if (s?.payload) initialScans[s.client_link_id] = { drift: s.payload, scannedAt: s.scanned_at, scannedBy: s.scanned_by_name ?? null };
    }
  } catch { /* table absent pre-migration — start empty */ }

  return (
    <AppShell>
      <TopBar
        title="COA Audit"
        subtitle="How close each client's QuickBooks chart is to the master COA — read-only triage"
      />
      <div className="px-8 py-6 max-w-6xl">
        <CoaAuditClient
          clients={(clients || []).map((c) => ({ id: c.id, client_name: c.client_name, jurisdiction: (c as any).jurisdiction ?? null }))}
          initialScans={initialScans}
          isOwner={isOwner}
        />
      </div>
    </AppShell>
  );
}
