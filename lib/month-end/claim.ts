import { STALE_CLAIM_MS } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export type MonthEndPackageRow = Record<string, unknown> & {
  id: string;
  client_link_id: string;
  status: string;
  period_year: number;
  period_month: number;
  period_end: string;
  ai_summary: string | null;
  ai_summary_reviewed: boolean;
  reclass_job_id: string | null;
};

const STALE_CUTOFF = () => new Date(Date.now() - STALE_CLAIM_MS).toISOString();

/**
 * Recover packages stuck mid-send or mid-AI-generation.
 * Called at the start of send/generate batches and by the global stale sweep.
 */
export async function recoverStaleMonthEndPackages(
  service: Service
): Promise<{ sendingReset: number; summaryPendingReset: number }> {
  const cutoff = STALE_CUTOFF();
  let sendingReset = 0;
  let summaryPendingReset = 0;

  try {
    const { data: sending } = await service
      .from("month_end_packages")
      .update({
        status: "ready_to_send",
        send_error: "Auto-recovered: send timed out — safe to retry.",
        updated_at: new Date().toISOString(),
      } as any)
      .eq("status", "sending")
      .lt("updated_at", cutoff)
      .select("id");
    sendingReset = sending?.length || 0;

    const { data: pending } = await service
      .from("month_end_packages")
      .update({
        status: "draft",
        send_error: "Auto-recovered: summary generation timed out — safe to retry.",
        updated_at: new Date().toISOString(),
      } as any)
      .eq("status", "summary_pending")
      .lt("updated_at", cutoff)
      .select("id");
    summaryPendingReset = pending?.length || 0;
  } catch {
    // table may not exist until migration applied
  }

  return { sendingReset, summaryPendingReset };
}

export async function claimPackageForSend(
  service: Service,
  packageId: string
): Promise<
  | { ok: true; pkg: MonthEndPackageRow; alreadySent?: boolean }
  | { ok: false; error: string }
> {
  const { data: existing } = await service
    .from("month_end_packages")
    .select("*")
    .eq("id", packageId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "Package not found" };
  const pkg = existing as MonthEndPackageRow;

  if (pkg.status === "sent") {
    return { ok: true, pkg, alreadySent: true };
  }

  if (pkg.status !== "ready_to_send") {
    return { ok: false, error: `Package status is ${pkg.status}, expected ready_to_send` };
  }

  if (!pkg.ai_summary_reviewed || !pkg.ai_summary?.trim()) {
    return { ok: false, error: "AI summary not reviewed" };
  }

  const now = new Date().toISOString();
  const { data: claimed } = await service
    .from("month_end_packages")
    .update({ status: "sending", updated_at: now, send_error: null } as any)
    .eq("id", packageId)
    .eq("status", "ready_to_send")
    .select("*")
    .maybeSingle();

  if (!claimed) {
    return { ok: false, error: "Could not claim package (concurrent send or status changed)" };
  }

  return { ok: true, pkg: claimed as MonthEndPackageRow };
}

export async function releaseSendClaim(
  service: Service,
  packageId: string,
  error: string,
  toStatus: "ready_to_send" | "failed" = "ready_to_send"
): Promise<void> {
  await service
    .from("month_end_packages")
    .update({
      status: toStatus,
      send_error: error.slice(0, 2000),
      updated_at: new Date().toISOString(),
    } as any)
    .eq("id", packageId)
    .eq("status", "sending");
}

export async function claimPackageForSummary(
  service: Service,
  packageId: string
): Promise<{ ok: boolean; error?: string }> {
  const { data: pkg } = await service
    .from("month_end_packages")
    .select("id, status")
    .eq("id", packageId)
    .maybeSingle();

  if (!pkg) return { ok: false, error: "Package not found" };
  if ((pkg as any).status === "sent") return { ok: false, error: "Already sent" };
  if ((pkg as any).status === "summary_pending") {
    return { ok: false, error: "Summary generation already in progress" };
  }
  if (!["draft", "failed", "ready_to_send"].includes((pkg as any).status)) {
    return { ok: false, error: `Cannot generate summary for status ${(pkg as any).status}` };
  }

  const { data: claimed } = await service
    .from("month_end_packages")
    .update({ status: "summary_pending", send_error: null, updated_at: new Date().toISOString() } as any)
    .eq("id", packageId)
    .in("status", ["draft", "failed", "ready_to_send"])
    .select("id")
    .maybeSingle();

  if (!claimed) return { ok: false, error: "Could not claim for summary generation" };
  return { ok: true };
}
