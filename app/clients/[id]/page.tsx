import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { notFound, redirect } from "next/navigation";
import { ClientProfileShell } from "./client-profile-shell";
import {
  fetchOutstandingWork,
  fetchRecentActivity,
  fetchInternalSummary,
} from "@/lib/internal-client-profile";
import { getValidToken } from "@/lib/qbo";
import {
  fetchOverview,
  fetchBalanceSheetSummary,
  thisMonthRange,
  lastMonthRange,
} from "@/lib/portal-data";

/**
 * Internal client profile — the bookkeeper-facing view of a single client.
 *
 * Contrast with /portal/* (client-facing chrome, single-client tenant) and
 * /clients/[id]/match-double (single-purpose admin tool). This page is the
 * "open a client and see everything" view Mike asked for: financial
 * snapshots from QBO plus internal SNAP-side state (cleanups, rules,
 * reclasses, outstanding work).
 *
 * Architecture: this server component fetches everything Overview needs in
 * parallel and passes to a client shell that owns the tab state. Other
 * tabs (P&L / BS / Bank / Activity) lazy-load via tabbed routes underneath
 * (see /clients/[id]/{pl,bs,bank,activity}/page.tsx).
 */
export default async function ClientProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  // Permission: any internal role (bookkeeper / lead / admin) can view.
  // Clients should never land here — they're scoped to /portal.
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") redirect("/portal");

  // Cast through `any` because the generated database.types.ts is stale on
  // `last_synced_at` (real column, used in lib/daily-recon.ts). Same pattern
  // used elsewhere in this codebase pending a types regen.
  const { data: clientLinkRaw } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, industry, jurisdiction, state_province, status, last_synced_at, double_client_id, double_client_name" as any)
    .eq("id", id)
    .single();

  if (!clientLinkRaw) notFound();
  const clientLink = clientLinkRaw as unknown as {
    id: string;
    client_name: string;
    qbo_realm_id: string | null;
    industry: string | null;
    jurisdiction: string | null;
    state_province: string | null;
    status: string | null;
    last_synced_at: string | null;
    double_client_id: string | null;
    double_client_name: string | null;
  };

  // Parallel-load all data for every tab so the user can switch tabs
  // without spinners. Each fetch is independent and failure-tolerant —
  // a QBO timeout on one report doesn't blank the whole page.
  //
  // QBO data only loaded when the client has a realm + a token can be
  // minted. New/disconnected clients skip the QBO calls entirely and the
  // financial tabs render an empty-state instead of crashing.
  const hasQbo = !!clientLink.qbo_realm_id;

  const primaryRange = thisMonthRange();
  const comparisonRange = lastMonthRange();

  const tokenPromise: Promise<string | null> = hasQbo
    ? getValidToken(id, service as any).catch((e) => {
        console.warn(`[client-profile ${id}] token fetch failed:`, e?.message);
        return null;
      })
    : Promise.resolve(null);

  const [outstanding, activity, summary, accessToken] = await Promise.all([
    fetchOutstandingWork(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] outstanding work failed:`, e?.message);
      return null;
    }),
    fetchRecentActivity(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] activity failed:`, e?.message);
      return [];
    }),
    fetchInternalSummary(service, id).catch((e) => {
      console.warn(`[client-profile ${id}] summary failed:`, e?.message);
      return null;
    }),
    tokenPromise,
  ]);

  // QBO-dependent fetches gated on having a token. Failure-tolerant so
  // the page still renders even if one report endpoint times out.
  let overview = null;
  let balanceSheet = null;
  if (accessToken && clientLink.qbo_realm_id) {
    const realmId = clientLink.qbo_realm_id;
    [overview, balanceSheet] = await Promise.all([
      fetchOverview(realmId, accessToken, primaryRange, comparisonRange).catch((e) => {
        console.warn(`[client-profile ${id}] overview QBO fetch failed:`, e?.message);
        return null;
      }),
      fetchBalanceSheetSummary(realmId, accessToken).catch((e) => {
        console.warn(`[client-profile ${id}] BS QBO fetch failed:`, e?.message);
        return null;
      }),
    ]);
  }

  return (
    <AppShell>
      <TopBar
        title={clientLink.client_name || "Client"}
        subtitle={
          [
            clientLink.industry,
            clientLink.state_province || clientLink.jurisdiction,
            clientLink.status,
          ]
            .filter(Boolean)
            .join(" · ") || "Client profile"
        }
      />
      <ClientProfileShell
        clientLink={clientLink as any}
        actorRole={role}
        overview={{
          outstanding,
          activity,
          summary,
        }}
        financials={{
          overview,
          balanceSheet,
          primaryRangeLabel: `${primaryRange.start} → ${primaryRange.end}`,
          comparisonRangeLabel: `${comparisonRange.start} → ${comparisonRange.end}`,
          hasQbo,
        }}
      />
    </AppShell>
  );
}
