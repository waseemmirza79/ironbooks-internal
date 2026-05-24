import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { PortalErrorState } from "../error-state";
import { ProfitLossClient } from "./profit-loss-client";

/**
 * Live P&L page. The server fetches all four common ranges in parallel so
 * the bookkeeper can toggle between them without round-trips. Client
 * component owns the period switcher + presentation.
 *
 * Why pre-fetch all ranges instead of fetching on change? P&L is the
 * most-viewed portal page; the latency of switching periods matters more
 * than the upfront cost. Each report is small JSON.
 */
export const dynamic = "force-dynamic";

export default async function ProfitLossPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const now = new Date();
  const ranges = {
    thisMonth: {
      label: "This month",
      start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
      end: now.toISOString().slice(0, 10),
    },
    lastMonth: {
      label: "Last month",
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10),
      end: new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10),
    },
    quarter: {
      label: "This quarter",
      start: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).toISOString().slice(0, 10),
      end: now.toISOString().slice(0, 10),
    },
    ytd: {
      label: "Year to date",
      start: `${now.getFullYear()}-01-01`,
      end: now.toISOString().slice(0, 10),
    },
  };

  // Parallel fetch all 4 ranges. Errors fall through to empty placeholder
  // values — the client will render the screen with whatever it gets.
  const [thisMonth, lastMonth, quarter, ytd] = await Promise.all([
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.thisMonth.start, ranges.thisMonth.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.lastMonth.start, ranges.lastMonth.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.quarter.start, ranges.quarter.end)),
    safeFetch(() => fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, ranges.ytd.start, ranges.ytd.end)),
  ]);

  return (
    <ProfitLossClient
      ranges={ranges}
      data={{
        thisMonth,
        lastMonth,
        quarter,
        ytd,
      }}
    />
  );
}

async function safeFetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
