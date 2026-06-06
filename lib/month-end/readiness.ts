import type { FleetReadinessSummary, ClientReadiness, PeriodBounds } from "./types";
import { periodBounds, priorPeriod } from "./period";
import { evaluateOperationalGates } from "./operational-gates";
import { pickBestReclassJob } from "./reclass-match";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

const BLOCK_LABELS: Record<string, string> = {
  reclass_incomplete: "Reclass not complete for this month",
  today_pending: "Today inbox has pending items",
  daily_recon_paused: "Daily recon is paused",
  summary_not_reviewed: "AI summary not reviewed",
  package_not_built: "Package not built yet",
  already_sent: "Already delivered",
  qbo_token_missing: "QBO not connected",
  no_reclass_job: "No reclass job for this month",
};

interface FleetContext {
  clients: Array<{
    id: string;
    client_name: string;
    daily_recon_paused?: boolean;
    qbo_refresh_token?: string | null;
  }>;
  packagesByClient: Map<
    string,
    { id: string; status: string; ai_summary_reviewed: boolean; ai_summary?: string | null }
  >;
  pendingByClient: Map<string, number>;
  reclassByClient: Map<
    string,
    Array<{ id: string; status: string; date_range_start: string; date_range_end: string }>
  >;
}

async function loadFleetContext(
  service: Service,
  period: PeriodBounds,
  options?: { bookkeeperId?: string | null; clientIds?: string[] }
): Promise<FleetContext> {
  let clientsQuery = service
    .from("client_links")
    .select("id, client_name, daily_recon_paused, qbo_refresh_token, assigned_bookkeeper_id")
    .eq("is_active", true);

  if (options?.bookkeeperId) {
    clientsQuery = clientsQuery.eq("assigned_bookkeeper_id", options.bookkeeperId);
  }
  if (options?.clientIds?.length) {
    clientsQuery = clientsQuery.in("id", options.clientIds);
  }

  const { data: clients } = await clientsQuery.order("client_name");
  const clientList = (clients || []) as FleetContext["clients"];
  const clientIds = clientList.map((c) => c.id);

  const packagesByClient = new Map<
    string,
    {
      id: string;
      status: string;
      ai_summary_reviewed: boolean;
      ai_summary?: string | null;
    }
  >();
  const pendingByClient = new Map<string, number>();
  const reclassByClient = new Map<string, FleetContext["reclassByClient"] extends Map<string, infer V> ? V : never>();

  if (!clientIds.length) {
    return { clients: clientList, packagesByClient, pendingByClient, reclassByClient };
  }

  const [{ data: packages }, { data: pending }, { data: reclassJobs }] = await Promise.all([
    service
      .from("month_end_packages")
      .select("id, client_link_id, status, ai_summary_reviewed, ai_summary")
      .eq("period_year", period.periodYear)
      .eq("period_month", period.periodMonth)
      .in("client_link_id", clientIds),
    service
      .from("daily_review_queue")
      .select("client_link_id")
      .eq("decision", "pending")
      .in("client_link_id", clientIds),
    service
      .from("reclass_jobs")
      .select("id, client_link_id, status, date_range_start, date_range_end")
      .eq("status", "complete")
      .lte("date_range_start", period.periodEnd)
      .gte("date_range_end", period.periodStart)
      .in("client_link_id", clientIds),
  ]);

  for (const p of (packages || []) as any[]) {
    packagesByClient.set(p.client_link_id, p);
  }

  for (const row of (pending || []) as { client_link_id: string }[]) {
    pendingByClient.set(
      row.client_link_id,
      (pendingByClient.get(row.client_link_id) || 0) + 1
    );
  }

  for (const j of (reclassJobs || []) as any[]) {
    const list = reclassByClient.get(j.client_link_id) || [];
    list.push(j);
    reclassByClient.set(j.client_link_id, list);
  }

  return { clients: clientList, packagesByClient, pendingByClient, reclassByClient };
}

function assessFromContext(
  client: FleetContext["clients"][number],
  period: PeriodBounds,
  ctx: FleetContext
): ClientReadiness {
  const existingPackage = ctx.packagesByClient.get(client.id) || null;

  if (existingPackage?.status === "sent") {
    return {
      clientLinkId: client.id,
      clientName: client.client_name,
      operationallyReady: false,
      deliverable: false,
      blockReasons: ["already_sent"],
      blockLabels: [BLOCK_LABELS.already_sent],
      reclassJobId: null,
      todayPendingCount: ctx.pendingByClient.get(client.id) || 0,
      packageId: existingPackage.id,
      packageStatus: "sent",
      aiSummaryReviewed: true,
    };
  }

  const gates = evaluateOperationalGates({
    clientLinkId: client.id,
    qboRefreshToken: client.qbo_refresh_token,
    dailyReconPaused: client.daily_recon_paused,
    todayPendingCount: ctx.pendingByClient.get(client.id) || 0,
    reclassJobs: ctx.reclassByClient.get(client.id) || [],
    period,
  });

  const blockReasons = [...gates.blockReasons];
  const packageStatus = (existingPackage?.status as ClientReadiness["packageStatus"]) || null;
  const aiSummaryReviewed = existingPackage?.ai_summary_reviewed || false;
  const operationallyReady = gates.ok;

  if (operationallyReady && !existingPackage) {
    blockReasons.push("package_not_built");
  }

  if (
    operationallyReady &&
    existingPackage &&
    existingPackage.status !== "ready_to_send" &&
    !aiSummaryReviewed
  ) {
    blockReasons.push("summary_not_reviewed");
  }

  const deliverable =
    operationallyReady &&
    !!existingPackage &&
    existingPackage.status === "ready_to_send" &&
    aiSummaryReviewed &&
    !!existingPackage.ai_summary?.trim();

  return {
    clientLinkId: client.id,
    clientName: client.client_name,
    operationallyReady,
    deliverable,
    blockReasons,
    blockLabels: blockReasons.map((r) => BLOCK_LABELS[r] || r),
    reclassJobId: gates.reclassJobId,
    todayPendingCount: ctx.pendingByClient.get(client.id) || 0,
    packageId: existingPackage?.id || null,
    packageStatus,
    aiSummaryReviewed,
  };
}

export async function assessClientReadiness(
  service: Service,
  client: {
    id: string;
    client_name: string;
    daily_recon_paused?: boolean;
    qbo_refresh_token?: string | null;
  },
  period: PeriodBounds,
  existingPackage?: {
    id: string;
    status: string;
    ai_summary_reviewed: boolean;
    ai_summary?: string | null;
  } | null
): Promise<ClientReadiness> {
  const [{ count: pendingCount }, { data: jobs }] = await Promise.all([
    service
      .from("daily_review_queue")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", client.id)
      .eq("decision", "pending"),
    service
      .from("reclass_jobs")
      .select("id, status, date_range_start, date_range_end")
      .eq("client_link_id", client.id)
      .eq("status", "complete")
      .lte("date_range_start", period.periodEnd)
      .gte("date_range_end", period.periodStart),
  ]);

  const ctx: FleetContext = {
    clients: [client],
    packagesByClient: existingPackage
      ? new Map([[client.id, existingPackage]])
      : new Map(),
    pendingByClient: new Map([[client.id, pendingCount || 0]]),
    reclassByClient: new Map([[client.id, (jobs || []) as any[]]]),
  };

  return assessFromContext(client, period, ctx);
}

export async function buildFleetReadiness(
  service: Service,
  periodRef: { periodYear: number; periodMonth: number },
  options?: { bookkeeperId?: string | null; clientIds?: string[] }
): Promise<FleetReadinessSummary> {
  const period = periodBounds(periodRef);
  const ctx = await loadFleetContext(service, period, options);

  const assessments = ctx.clients.map((c) => assessFromContext(c, period, ctx));

  const ready = assessments.filter((a) => a.deliverable);
  const sent = assessments.filter((a) => a.packageStatus === "sent");
  const failed = assessments.filter((a) => a.packageStatus === "failed");
  const blocked = assessments.filter(
    (a) => !a.deliverable && a.packageStatus !== "sent" && a.packageStatus !== "failed"
  );

  return {
    period,
    ready,
    blocked,
    sent,
    failed,
    counts: {
      ready: ready.length,
      blocked: blocked.length,
      sent: sent.length,
      failed: failed.length,
      draft: assessments.filter((a) => a.packageStatus === "draft").length,
      summaryPending: assessments.filter((a) => a.packageStatus === "summary_pending").length,
    },
  };
}

export { priorPeriod, periodBounds, pickBestReclassJob };
