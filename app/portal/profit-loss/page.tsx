import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { resolveClosedPeriod, lastYearRange, ytdRange, thisMonthRange, quarterRange, type DateRange } from "@/lib/portal-data";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { ProfitLossClient } from "./profit-loss-client";

/**
 * Live P&L page. Defaults to the most-recently-closed month ("Last month")
 * — see resolveClosedPeriod for the priority order.
 *
 * 5 ranges pre-fetched in parallel so the period switcher is instant:
 *   - Last month     (closed period, the default)
 *   - This month     (in-progress, may be unreconciled — caveat shown)
 *   - This quarter
 *   - Year to date
 *   - Last year      (full calendar year prior)
 */
export const dynamic = "force-dynamic";

export default async function ProfitLossPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();
  const closed = await resolveClosedPeriod(service, ctx.clientLinkId);

  const ranges: Record<string, DateRange> = {
    lastMonth: { ...closed.closedMonth, label: `Last month (${closed.closedMonthLabel})` },
    thisMonth: thisMonthRange(),
    quarter: quarterRange(),
    ytd: ytdRange(),
    lastYear: lastYearRange(),
  };

  const [lastMonth, thisMonth, quarter, ytd, lastYear] = await Promise.all([
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.lastMonth.start, ranges.lastMonth.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.thisMonth.start, ranges.thisMonth.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.quarter.start, ranges.quarter.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.ytd.start, ranges.ytd.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.lastYear.start, ranges.lastYear.end)),
  ]);

  return (
    <ProfitLossClient
      ranges={ranges as any}
      data={{ lastMonth, thisMonth, quarter, ytd, lastYear }}
      closedSource={closed.source}
    />
  );
}

async function safeFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
