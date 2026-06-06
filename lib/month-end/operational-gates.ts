import type { PeriodBounds, ReadinessBlockReason } from "./types";
import { pickBestReclassJob } from "./reclass-match";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface OperationalGateInput {
  clientLinkId: string;
  qboRefreshToken?: string | null;
  dailyReconPaused?: boolean;
  todayPendingCount: number;
  reclassJobs: Array<{
    id: string;
    status: string;
    date_range_start: string;
    date_range_end: string;
  }>;
  period: PeriodBounds;
}

export interface OperationalGateResult {
  ok: boolean;
  blockReasons: ReadinessBlockReason[];
  reclassJobId: string | null;
}

export function evaluateOperationalGates(input: OperationalGateInput): OperationalGateResult {
  const blockReasons: ReadinessBlockReason[] = [];

  if (!input.qboRefreshToken) {
    blockReasons.push("qbo_token_missing");
  }

  const reclassJob = pickBestReclassJob(input.reclassJobs, input.period);
  if (!reclassJob) {
    blockReasons.push("no_reclass_job");
  }

  if (input.todayPendingCount > 0) {
    blockReasons.push("today_pending");
  }

  if (input.dailyReconPaused) {
    blockReasons.push("daily_recon_paused");
  }

  return {
    ok: blockReasons.length === 0,
    blockReasons,
    reclassJobId: reclassJob?.id || null,
  };
}

export async function verifyOperationalGates(
  service: Service,
  clientLinkId: string,
  period: PeriodBounds
): Promise<OperationalGateResult> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_refresh_token, daily_recon_paused")
    .eq("id", clientLinkId)
    .single();

  const { count: pendingCount } = await service
    .from("daily_review_queue")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", clientLinkId)
    .eq("decision", "pending");

  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id, status, date_range_start, date_range_end")
    .eq("client_link_id", clientLinkId)
    .eq("status", "complete")
    .lte("date_range_start", period.periodEnd)
    .gte("date_range_end", period.periodStart);

  return evaluateOperationalGates({
    clientLinkId,
    qboRefreshToken: client?.qbo_refresh_token,
    dailyReconPaused: client?.daily_recon_paused,
    todayPendingCount: pendingCount || 0,
    reclassJobs: (jobs || []) as OperationalGateInput["reclassJobs"],
    period,
  });
}
