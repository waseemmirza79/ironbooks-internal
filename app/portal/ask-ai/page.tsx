import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOverview, resolveClosedPeriodWithRevenue } from "@/lib/portal-data";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { AskAiClient } from "./ask-ai-client";

export const dynamic = "force-dynamic";

/**
 * AI Q&A — streaming Claude with this client's QBO context.
 *
 * Server component gates access AND computes dynamic conversation starters
 * based on the client's actual financial state. A generic "Explain my P&L"
 * is fine when there's nothing notable; specific prompts ("Why are subs up
 * 39%?") are way more valuable when the data screams about something.
 */
export default async function AskAiPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  // Build dynamic starter prompts from the closed-month overview snapshot.
  // Heavy lifting is one parallel fetch — small cost for a much better first
  // impression vs static prompts the user has seen 10 times.
  //
  // Use the revenue-aware closed period so the starters reference the same
  // month the Overview and P&L tabs land on. A client like Zuno whose latest
  // "closed" month reports $0 income steps back to the last month with real
  // activity, so prompts say "Why did April run a loss?" not an empty May.
  const service = createServiceSupabase();
  const closed = await resolveClosedPeriodWithRevenue(
    service,
    ctx.clientLinkId,
    ctx.qboRealmId,
    ctx.accessToken
  );
  // No reconciled month → data-driven starters would reference numbers we
  // won't show, so fall back to the generic starters. The AI chat itself
  // stays available (it can still answer general questions).
  const overview = closed
    ? await fetchOverview(
        ctx.qboRealmId,
        ctx.accessToken,
        closed.effectiveMonth,
        closed.priorMonth,
        closed.effectivePL // reuse the P&L the resolver already fetched
      ).catch(() => null)
    : null;

  const starters =
    overview && closed
      ? buildDynamicStarters(overview, closed.effectiveMonth.label ?? closed.base.closedMonthLabel)
      : DEFAULT_STARTERS;

  return <AskAiClient starters={starters} />;
}

const DEFAULT_STARTERS = [
  "Why did profit change this month?",
  "Can I afford to hire another person?",
  "What's a healthy profit margin for my business?",
  "How much should I set aside for taxes?",
  "Explain my balance sheet in plain English.",
];

function buildDynamicStarters(
  o: Awaited<ReturnType<typeof fetchOverview>>,
  monthLabel: string
): string[] {
  const starters: string[] = [];
  const monthShort = monthLabel.split(" ")[0];

  const profit = o.primaryPL.netIncome;
  const prevProfit = o.comparisonPL.netIncome;
  const income = o.primaryPL.totalIncome;
  const expenses = o.primaryPL.totalExpenses;
  const profitDelta = profit - prevProfit;
  const incomeDelta = income - o.comparisonPL.totalIncome;

  // 1. Profit movement
  if (profit < 0) {
    starters.push(`Why did ${monthShort} run a loss?`);
  } else if (profitDelta < -1000) {
    starters.push(`Why was ${monthShort}'s profit down vs the prior month?`);
  } else if (profitDelta > 5000) {
    starters.push(`What drove the profit jump in ${monthShort} — and is it repeatable?`);
  } else if (profit > 0 && income > 0) {
    const margin = Math.round((profit / income) * 100);
    starters.push(`Is a ${margin}% profit margin healthy for my business?`);
  }

  // 2. Overdue A/R
  if (o.overdueARTotal > 1000) {
    starters.push(`How should I follow up on the ${formatMoney(o.overdueARTotal)} in overdue invoices?`);
  }

  // 3. Cash flow tightness
  const cashOnHand = o.banks.totalCashOnHand;
  if (cashOnHand > 0 && o.openAPTotal > 0) {
    const ratio = o.openAPTotal / cashOnHand;
    if (ratio > 0.6) {
      starters.push(`Can I cover all my unpaid bills with the cash I have?`);
    } else if (ratio < 0.2 && cashOnHand > 20000) {
      starters.push(`What should I do with the extra cash sitting in my bank account?`);
    }
  } else if (cashOnHand < 5000 && expenses > 0) {
    starters.push(`How worried should I be about my cash position?`);
  }

  // 4. Big expense category — find the biggest expense line that grew the
  // most vs prior month
  const prevLineMap = new Map(o.comparisonPL.lineItems.map((l) => [l.label, l.amount]));
  let biggestJump: { label: string; current: number; prior: number; delta: number } | null = null;
  for (const line of o.primaryPL.lineItems) {
    if (!/expense|cost|cogs/i.test(line.group || "")) continue;
    if (Math.abs(line.amount) < 500) continue;
    const prior = prevLineMap.get(line.label) ?? 0;
    const delta = Math.abs(line.amount) - Math.abs(prior);
    if (delta > 1000 && (!biggestJump || delta > biggestJump.delta)) {
      biggestJump = { label: line.label, current: Math.abs(line.amount), prior: Math.abs(prior), delta };
    }
  }
  if (biggestJump) {
    starters.push(`Why is ${biggestJump.label} up so much in ${monthShort}?`);
  }

  // 5. Revenue concentration check
  if (incomeDelta < -2000 && income > 0) {
    starters.push(`Revenue is down — what should I focus on this quarter?`);
  } else if (incomeDelta > 5000) {
    starters.push(`How should I plan now that revenue is growing?`);
  }

  // Fill out to at least 5 with safe defaults
  for (const fallback of DEFAULT_STARTERS) {
    if (starters.length >= 5) break;
    if (!starters.includes(fallback)) starters.push(fallback);
  }

  return starters.slice(0, 5);
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
