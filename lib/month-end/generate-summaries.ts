import { generateMonthEndSummary } from "./ai-summary";
import { periodBounds } from "./period";
import type { PlSnapshot, BsSnapshot, ArApSnapshot, DailyReconStats } from "./types";
import { claimPackageForSummary, recoverStaleMonthEndPackages } from "./claim";
import { GENERATE_WAVE_SIZE } from "./constants";
import { mapPool } from "./concurrency";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export async function generateSummaryForPackage(
  service: Service,
  packageId: string
): Promise<{ ok: boolean; error?: string }> {
  const claim = await claimPackageForSummary(service, packageId);
  if (!claim.ok) return { ok: false, error: claim.error };

  const { data: pkg } = await service
    .from("month_end_packages")
    .select("*, client_links(client_name, industry, jurisdiction)")
    .eq("id", packageId)
    .single();

  if (!pkg) {
    await service
      .from("month_end_packages")
      .update({ status: "draft", updated_at: new Date().toISOString() } as any)
      .eq("id", packageId)
      .eq("status", "summary_pending");
    return { ok: false, error: "Package not found after claim" };
  }

  try {
    const period = periodBounds({
      periodYear: (pkg as any).period_year,
      periodMonth: (pkg as any).period_month,
    });
    const client = (pkg as any).client_links;

    const summary = await generateMonthEndSummary({
      clientName: client?.client_name || "Client",
      industry: client?.industry,
      jurisdiction: client?.jurisdiction,
      period,
      pl: (pkg as any).pl_snapshot as PlSnapshot,
      bs: (pkg as any).bs_snapshot as BsSnapshot,
      arAp: (pkg as any).ar_ap_snapshot as ArApSnapshot,
      dailyRecon: (pkg as any).daily_recon_stats as DailyReconStats,
    });

    const { data: saved } = await service
      .from("month_end_packages")
      .update({
        status: "draft",
        ai_summary: summary,
        ai_summary_reviewed: false,
        ai_summary_reviewed_by: null,
        ai_summary_reviewed_at: null,
        send_error: null,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", packageId)
      .eq("status", "summary_pending")
      .select("id")
      .maybeSingle();

    if (!saved) return { ok: false, error: "Lost claim during summary save" };
    return { ok: true };
  } catch (err: any) {
    await service
      .from("month_end_packages")
      .update({
        status: "failed",
        send_error: (err?.message || "Summary generation failed").slice(0, 2000),
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", packageId)
      .eq("status", "summary_pending");
    return { ok: false, error: err?.message || "Summary generation failed" };
  }
}

export async function generateSummariesBatch(
  service: Service,
  packageIds: string[],
  waveSize = GENERATE_WAVE_SIZE
): Promise<{ generated: number; failed: number; errors: string[] }> {
  await recoverStaleMonthEndPackages(service);

  const uniqueIds = [...new Set(packageIds)];
  let generated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < uniqueIds.length; i += waveSize) {
    const wave = uniqueIds.slice(i, i + waveSize);
    const results = await mapPool(wave, 3, (id) =>
      generateSummaryForPackage(service, id)
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].ok) generated++;
      else {
        failed++;
        errors.push(`${wave[j]}: ${results[j].error}`);
      }
    }
  }

  return { generated, failed, errors };
}
