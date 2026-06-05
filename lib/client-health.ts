/**
 * Client Health Scoring — for the Strategic Advisor Dashboard.
 *
 * Computes a 0-100 score per client across 5 financial-health dimensions,
 * tiered to red / yellow / green for quick triage. Designed so advisors
 * spending limited time can spot "who needs help RIGHT NOW" without
 * drilling into each client's books.
 *
 * Scoring philosophy:
 *   - Cash runway is the most important signal — businesses die when
 *     they run out of cash, not when they post a bad month.
 *   - Negative + accelerating trends matter more than absolute levels.
 *   - "Bad books" itself counts — a broken QBO connection or 6 stuck
 *     cleanup jobs means we literally can't see what's happening, which
 *     is its own emergency.
 *
 * Returns enough detail (`reasons` array) for the UI to show "why is this
 * client flagged?" at a glance without needing a second backend call.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidToken } from "./qbo";
import {
  fetchOverview,
  thisMonthRange,
  lastMonthRange,
  type DateRange,
} from "./portal-data";

// ─── Types ────────────────────────────────────────────────────────────────

export type HealthTier = "critical" | "at_risk" | "healthy" | "no_data";

/** Per-dimension breakdown — exposed so the UI can show which factors
 *  hurt this client's score the most. */
export interface HealthDimension {
  key: "cash_runway" | "profitability" | "ar_health" | "ap_pressure" | "books_quality";
  label: string;
  score: number; // 0-100
  /** Human-readable "this is what's happening" snippet for the UI. */
  reason: string;
  /** Optional dollar / day / count detail useful for the card. */
  metric?: string;
}

export interface ClientHealth {
  clientLinkId: string;
  clientName: string;
  assignedBookkeeperId: string | null;
  assignedBookkeeperName: string | null;
  /** 0-100 weighted aggregate. */
  score: number;
  tier: HealthTier;
  /** Per-dimension scores + reasons. Sorted worst → best for the UI. */
  dimensions: HealthDimension[];
  /** Top 3 reasons to surface on the card (worst dimensions). */
  topReasons: string[];
  /** Rough "money at risk" — cash + open A/R. Drives the dashboard's
   *  "$X under management" summary tile. */
  cashOnHand: number;
  openAr: number;
  /** When the score was computed, for "X min ago" UI freshness label. */
  computedAt: string;
  /** Null when QBO fetch fails or client has no QBO connection. */
  error: string | null;
}

// ─── Scoring constants ───────────────────────────────────────────────────

const WEIGHTS = {
  cash_runway: 0.35, // highest — cash is survival
  profitability: 0.2,
  ar_health: 0.2,
  ap_pressure: 0.15,
  books_quality: 0.1,
} as const;

const TIER_THRESHOLDS = {
  critical: 40, // 0-40 = critical
  at_risk: 70,  // 41-70 = at risk; 71-100 = healthy
} as const;

// ─── Per-dimension scorers ───────────────────────────────────────────────

/** Months of runway = cash on hand / avg monthly burn.
 *  - <1 month  → 0pts (critical)
 *  - 1-3       → 30pts
 *  - 3-6       → 60pts
 *  - 6-12      → 85pts
 *  - 12+       → 100pts (healthy)
 *  Avg monthly burn estimated from this+last month's total expenses.
 *  When expenses are ~0 we treat runway as "infinite" → 100. */
function scoreCashRunway(cashOnHand: number, avgMonthlyExpenses: number): HealthDimension {
  if (cashOnHand <= 0) {
    return {
      key: "cash_runway",
      label: "Cash runway",
      score: 0,
      reason: "Cash balance is zero or negative — immediate liquidity crisis.",
      metric: `$${Math.round(cashOnHand).toLocaleString()} cash`,
    };
  }
  if (avgMonthlyExpenses <= 100) {
    // Essentially no expenses — likely a dormant or brand-new client.
    return {
      key: "cash_runway",
      label: "Cash runway",
      score: 100,
      reason: "Negligible monthly expenses — cash position is comfortable.",
      metric: `$${Math.round(cashOnHand).toLocaleString()} cash`,
    };
  }
  const months = cashOnHand / avgMonthlyExpenses;
  let score: number;
  let reason: string;
  if (months < 1) {
    score = Math.round(months * 10); // 0-10 pts within the < 1 month band
    reason = `Less than 1 month of cash runway — needs immediate intervention.`;
  } else if (months < 3) {
    score = 10 + Math.round((months - 1) * 10); // 10-30
    reason = `Only ${months.toFixed(1)} months of runway — narrow margin for surprises.`;
  } else if (months < 6) {
    score = 30 + Math.round((months - 3) * 10); // 30-60
    reason = `${months.toFixed(1)} months of runway — tight but manageable.`;
  } else if (months < 12) {
    score = 60 + Math.round((months - 6) * 25 / 6); // 60-85
    reason = `${months.toFixed(1)} months of cash runway — healthy buffer.`;
  } else {
    score = Math.min(100, 85 + Math.round((months - 12) * 15 / 12));
    reason = `${months >= 24 ? "24+" : months.toFixed(1)} months of cash runway — very strong position.`;
  }
  return {
    key: "cash_runway",
    label: "Cash runway",
    score,
    reason,
    metric: `${months >= 24 ? "24+" : months.toFixed(1)} mo · $${Math.round(cashOnHand).toLocaleString()}`,
  };
}

/** Profitability trend: net income this month vs last month.
 *  Heavily weights direction — a declining-but-positive client is yellow,
 *  a growing-but-negative client is also yellow, deep-loss + declining is red. */
function scoreProfitability(thisMonthNI: number, lastMonthNI: number): HealthDimension {
  // Edge: both zero — likely dormant.
  if (Math.abs(thisMonthNI) < 1 && Math.abs(lastMonthNI) < 1) {
    return {
      key: "profitability",
      label: "Profitability trend",
      score: 50,
      reason: "No P&L activity to score — likely dormant or new client.",
    };
  }
  const change = thisMonthNI - lastMonthNI;
  const pctChange =
    Math.abs(lastMonthNI) > 100 ? (change / Math.abs(lastMonthNI)) * 100 : null;

  let score: number;
  let reason: string;
  if (thisMonthNI < 0 && change < 0) {
    // Negative AND getting worse — worst case
    score = 5;
    reason = `Net loss of $${Math.abs(Math.round(thisMonthNI)).toLocaleString()} this month, deteriorating from last month.`;
  } else if (thisMonthNI < 0) {
    // Losing but improving
    score = 30;
    reason = `Net loss of $${Math.abs(Math.round(thisMonthNI)).toLocaleString()} this month — but improving vs last month.`;
  } else if (change < 0 && pctChange !== null && pctChange < -50) {
    // Profitable but profit collapsing
    score = 35;
    reason = `Profit dropped ${Math.abs(Math.round(pctChange))}% month-over-month — investigate revenue drop.`;
  } else if (change < 0 && pctChange !== null && pctChange < -20) {
    score = 55;
    reason = `Profit down ${Math.abs(Math.round(pctChange))}% month-over-month — watch trend.`;
  } else if (change < 0) {
    score = 70;
    reason = `Profit slightly down month-over-month — normal seasonal variation likely.`;
  } else if (change > 0 && pctChange !== null && pctChange > 30) {
    score = 100;
    reason = `Profit up ${Math.round(pctChange)}% month-over-month — strong growth.`;
  } else {
    score = 90;
    reason = `Profitable + stable or growing month-over-month.`;
  }
  return {
    key: "profitability",
    label: "Profitability trend",
    score,
    reason,
    metric: `NI $${Math.round(thisMonthNI).toLocaleString()}${pctChange !== null ? ` (${pctChange > 0 ? "+" : ""}${Math.round(pctChange)}%)` : ""}`,
  };
}

/** A/R health: % of A/R overdue (anything past due date).
 *  Uses overdueARTotal / totalAR — high overdue ratio means customers
 *  aren't paying. */
function scoreArHealth(overdueAr: number, totalAr: number): HealthDimension {
  if (totalAr < 1) {
    return {
      key: "ar_health",
      label: "A/R aging",
      score: 100,
      reason: "No open A/R — all invoices paid (or no invoicing activity).",
    };
  }
  const overduePct = (overdueAr / totalAr) * 100;
  let score: number;
  let reason: string;
  if (overduePct >= 75) {
    score = 5;
    reason = `${Math.round(overduePct)}% of A/R is overdue — customers severely behind on payments.`;
  } else if (overduePct >= 50) {
    score = 25;
    reason = `${Math.round(overduePct)}% of A/R is overdue — collections problem brewing.`;
  } else if (overduePct >= 30) {
    score = 50;
    reason = `${Math.round(overduePct)}% of A/R overdue — needs collections push.`;
  } else if (overduePct >= 15) {
    score = 75;
    reason = `${Math.round(overduePct)}% of A/R overdue — typical for the industry.`;
  } else {
    score = 95;
    reason = `Only ${Math.round(overduePct)}% of A/R overdue — collections are tight.`;
  }
  return {
    key: "ar_health",
    label: "A/R aging",
    score,
    reason,
    metric: `${Math.round(overduePct)}% overdue · $${Math.round(totalAr).toLocaleString()} A/R`,
  };
}

/** A/P pressure: A/P balance vs cash on hand.
 *  If you owe more than you have in the bank, that's pressure. */
function scoreApPressure(apBalance: number, cashOnHand: number): HealthDimension {
  if (apBalance < 100) {
    return {
      key: "ap_pressure",
      label: "Bills owed",
      score: 100,
      reason: "Minimal outstanding bills.",
    };
  }
  if (cashOnHand <= 0) {
    return {
      key: "ap_pressure",
      label: "Bills owed",
      score: 0,
      reason: `$${Math.round(apBalance).toLocaleString()} in bills owed with zero cash — immediate problem.`,
      metric: `$${Math.round(apBalance).toLocaleString()} A/P`,
    };
  }
  const ratio = apBalance / cashOnHand;
  let score: number;
  let reason: string;
  if (ratio >= 3) {
    score = 5;
    reason = `Owe $${Math.round(apBalance).toLocaleString()} but only $${Math.round(cashOnHand).toLocaleString()} cash — ${ratio.toFixed(1)}× over.`;
  } else if (ratio >= 2) {
    score = 20;
    reason = `A/P balance is ${ratio.toFixed(1)}× cash on hand — significant pressure.`;
  } else if (ratio >= 1) {
    score = 45;
    reason = `Owe more than cash on hand (${ratio.toFixed(1)}× ratio) — manage cashflow carefully.`;
  } else if (ratio >= 0.5) {
    score = 75;
    reason = `A/P is ${Math.round(ratio * 100)}% of cash — comfortable.`;
  } else {
    score = 95;
    reason = `A/P is only ${Math.round(ratio * 100)}% of cash on hand.`;
  }
  return {
    key: "ap_pressure",
    label: "Bills owed",
    score,
    reason,
    metric: `$${Math.round(apBalance).toLocaleString()} A/P · ${ratio.toFixed(1)}× cash`,
  };
}

/** Books quality: open job count, QBO connection health.
 *  A client with broken books or stuck cleanups is one we can't see clearly. */
function scoreBooksQuality(opts: {
  openCoaJobs: number;
  openReclassJobs: number;
  qboConnected: boolean;
  daysSinceLastSync: number | null;
}): HealthDimension {
  const reasons: string[] = [];
  let score = 100;

  if (!opts.qboConnected) {
    score -= 60;
    reasons.push("QBO connection broken or never set up");
  } else if (opts.daysSinceLastSync !== null && opts.daysSinceLastSync > 30) {
    score -= 20;
    reasons.push(`Last QBO sync was ${opts.daysSinceLastSync} days ago`);
  }

  if (opts.openCoaJobs >= 3) {
    score -= 25;
    reasons.push(`${opts.openCoaJobs} COA cleanups stuck in review`);
  } else if (opts.openCoaJobs > 0) {
    score -= 10;
    reasons.push(`${opts.openCoaJobs} COA cleanup${opts.openCoaJobs === 1 ? "" : "s"} pending`);
  }

  if (opts.openReclassJobs >= 3) {
    score -= 20;
    reasons.push(`${opts.openReclassJobs} reclass jobs in review`);
  } else if (opts.openReclassJobs > 0) {
    score -= 5;
    reasons.push(`${opts.openReclassJobs} reclass job${opts.openReclassJobs === 1 ? "" : "s"} pending`);
  }

  score = Math.max(0, score);

  const reason =
    reasons.length === 0
      ? "Books are clean and current — no open SNAP work."
      : reasons.slice(0, 2).join(" · ");

  return {
    key: "books_quality",
    label: "Books quality",
    score,
    reason,
    metric:
      opts.qboConnected
        ? `${opts.openCoaJobs + opts.openReclassJobs} open jobs`
        : "QBO disconnected",
  };
}

// ─── Aggregate ───────────────────────────────────────────────────────────

function tierForScore(score: number): HealthTier {
  if (score <= TIER_THRESHOLDS.critical) return "critical";
  if (score <= TIER_THRESHOLDS.at_risk) return "at_risk";
  return "healthy";
}

/** Compute health for a single client. Failure-tolerant — if anything
 *  goes wrong, returns a no_data entry so the dashboard still shows
 *  the client rather than dropping them silently. */
export async function computeClientHealth(
  service: SupabaseClient,
  clientLink: {
    id: string;
    client_name: string;
    qbo_realm_id: string | null;
    last_synced_at: string | null;
    assigned_bookkeeper_id: string | null;
  },
  bookkeeperLookup: Map<string, string>
): Promise<ClientHealth> {
  const baseResult: ClientHealth = {
    clientLinkId: clientLink.id,
    clientName: clientLink.client_name || "(no name)",
    assignedBookkeeperId: clientLink.assigned_bookkeeper_id,
    assignedBookkeeperName: clientLink.assigned_bookkeeper_id
      ? bookkeeperLookup.get(clientLink.assigned_bookkeeper_id) ?? null
      : null,
    score: 0,
    tier: "no_data",
    dimensions: [],
    topReasons: [],
    cashOnHand: 0,
    openAr: 0,
    computedAt: new Date().toISOString(),
    error: null,
  };

  // No QBO at all → no_data tier with the books_quality dimension still
  // surfaced so the advisor sees "needs QBO connection".
  if (!clientLink.qbo_realm_id) {
    const openJobs = await countOpenJobs(service, clientLink.id);
    const booksDim = scoreBooksQuality({
      openCoaJobs: openJobs.coa,
      openReclassJobs: openJobs.reclass,
      qboConnected: false,
      daysSinceLastSync: null,
    });
    return {
      ...baseResult,
      tier: "no_data",
      dimensions: [booksDim],
      topReasons: [booksDim.reason],
      error: "QBO not connected",
    };
  }

  // Probe QBO + compute. Everything wrapped because one slow client
  // shouldn't break the dashboard.
  try {
    const accessToken = await getValidToken(clientLink.id, service as any);
    const primary: DateRange = thisMonthRange();
    const comparison: DateRange = lastMonthRange();
    const overview = await fetchOverview(
      clientLink.qbo_realm_id,
      accessToken,
      primary,
      comparison
    );

    const cashOnHand = overview.banks.totalCashOnHand;
    const totalAr = overview.openARTotal;
    const overdueAr = overview.overdueARTotal;
    const apBalance = overview.openAPTotal;
    const thisMonthNI = overview.primaryPL.netIncome;
    const lastMonthNI = overview.comparisonPL.netIncome;

    // Avg monthly expenses — average this + last month's totalExpenses.
    // Slightly more stable than "this month only" which spikes/dips a lot.
    const avgMonthlyExpenses =
      (overview.primaryPL.totalExpenses + overview.comparisonPL.totalExpenses) / 2;

    const openJobs = await countOpenJobs(service, clientLink.id);
    const daysSinceLastSync = clientLink.last_synced_at
      ? Math.floor(
          (Date.now() - new Date(clientLink.last_synced_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null;

    const dimensions: HealthDimension[] = [
      scoreCashRunway(cashOnHand, avgMonthlyExpenses),
      scoreProfitability(thisMonthNI, lastMonthNI),
      scoreArHealth(overdueAr, totalAr),
      scoreApPressure(apBalance, cashOnHand),
      scoreBooksQuality({
        openCoaJobs: openJobs.coa,
        openReclassJobs: openJobs.reclass,
        qboConnected: true,
        daysSinceLastSync,
      }),
    ];

    const score = Math.round(
      dimensions.reduce((sum, d) => sum + d.score * WEIGHTS[d.key], 0)
    );

    // Sort dimensions by score asc (worst first) so the UI surfaces
    // problems prominently.
    const sortedDims = [...dimensions].sort((a, b) => a.score - b.score);
    const topReasons = sortedDims
      .filter((d) => d.score < 70) // only show "things going wrong"
      .slice(0, 3)
      .map((d) => d.reason);

    return {
      ...baseResult,
      score,
      tier: tierForScore(score),
      dimensions: sortedDims,
      topReasons:
        topReasons.length > 0
          ? topReasons
          : ["All health indicators in good shape."],
      cashOnHand,
      openAr: totalAr,
    };
  } catch (err: any) {
    // QBO probably broken (revoked tokens, etc). Surface as no_data so
    // advisor still sees the client + knows to investigate the connection.
    const message = String(err?.message || err);
    const isAuthError = /invalid_grant|user_not_in_realm|token refresh/i.test(message);
    return {
      ...baseResult,
      tier: "no_data",
      topReasons: [
        isAuthError
          ? "QBO connection broken — needs reconnection by the client owner."
          : `Couldn't compute health: ${message.slice(0, 100)}`,
      ],
      error: isAuthError ? "qbo_auth_broken" : message.slice(0, 200),
    };
  }
}

/** Lightweight DB-only query — counts open coa_jobs + reclass_jobs that
 *  aren't finalized. Used by both the health-scoring and the no-QBO path. */
async function countOpenJobs(
  service: SupabaseClient,
  clientLinkId: string
): Promise<{ coa: number; reclass: number }> {
  const [coa, reclass] = await Promise.all([
    service
      .from("coa_jobs")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", clientLinkId)
      .in("status", ["in_review", "executing", "failed"]),
    service
      .from("reclass_jobs")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", clientLinkId)
      .in("status", ["in_review", "executing", "web_search_paused", "failed"]),
  ]);
  return {
    coa: coa.count ?? 0,
    reclass: reclass.count ?? 0,
  };
}

// ─── Bulk fetcher for the dashboard ─────────────────────────────────────

export interface DashboardData {
  computedAt: string;
  /** All clients, sorted by score asc (worst first). */
  clients: ClientHealth[];
  /** Quick aggregate stats for the summary tiles. */
  summary: {
    total: number;
    critical: number;
    at_risk: number;
    healthy: number;
    no_data: number;
    /** Sum of cashOnHand across all clients. */
    total_cash_managed: number;
    /** Sum of openAr across all clients — "money customers owe us". */
    total_ar_outstanding: number;
  };
}

/**
 * Compute health for EVERY client in parallel + assemble the dashboard
 * payload. With ~60 clients each doing ~3 QBO calls + 2 DB counts, this
 * takes 8-15 seconds on a warm token cache. Cold tokens (refreshes) push
 * it longer. Caller should expect Vercel's default 60s timeout to be
 * adequate but the route exports maxDuration=120 for safety.
 *
 * concurrencyLimit caps parallel QBO calls — running all 60 at once is
 * fine for Intuit's rate limit but exhausts Vercel function memory if
 * each one buffers a full Overview response simultaneously. Default 10
 * balances both.
 */
export async function fetchAdvisorDashboard(
  service: SupabaseClient,
  opts: { concurrencyLimit?: number; assignedBookkeeperId?: string | null } = {}
): Promise<DashboardData> {
  const concurrencyLimit = opts.concurrencyLimit ?? 10;

  // Pull active clients with QBO connections OR with pending bookkeeping
  // work. Skip explicitly inactive (paused / archived) clients — they're
  // not relevant to the advisor view.
  // Casting through `any` because is_active + last_synced_at are missing
  // from the stale generated types but present in the schema.
  let query = (service as any)
    .from("client_links")
    .select(
      "id, client_name, qbo_realm_id, last_synced_at, assigned_bookkeeper_id, is_active"
    )
    .order("client_name", { ascending: true });

  const { data: rawClients } = await query;
  const clients = ((rawClients as any[]) || []).filter(
    (c) => c.is_active !== false
  );

  // Filter by bookkeeper if asked
  const scoped = opts.assignedBookkeeperId
    ? clients.filter((c) => c.assigned_bookkeeper_id === opts.assignedBookkeeperId)
    : clients;

  // Resolve bookkeeper names in one shot (don't roundtrip per client)
  const bookkeeperIds = Array.from(
    new Set(scoped.map((c: any) => c.assigned_bookkeeper_id).filter(Boolean))
  );
  const bookkeeperLookup = new Map<string, string>();
  if (bookkeeperIds.length > 0) {
    const { data: bks } = await service
      .from("users")
      .select("id, full_name")
      .in("id", bookkeeperIds as string[]);
    for (const b of (bks || []) as any[]) {
      bookkeeperLookup.set(b.id, b.full_name || "(unnamed bookkeeper)");
    }
  }

  // Run health computation with bounded parallelism
  const healths: ClientHealth[] = [];
  for (let i = 0; i < scoped.length; i += concurrencyLimit) {
    const batch = scoped.slice(i, i + concurrencyLimit);
    const results = await Promise.all(
      batch.map((c: any) => computeClientHealth(service, c, bookkeeperLookup))
    );
    healths.push(...results);
  }

  // Sort: critical first, then at_risk, then healthy, then no_data.
  // Within each tier, lowest score first (= most urgent).
  const tierOrder: Record<HealthTier, number> = {
    critical: 0,
    at_risk: 1,
    healthy: 2,
    no_data: 3,
  };
  healths.sort((a, b) => {
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.score - b.score;
  });

  const summary = {
    total: healths.length,
    critical: healths.filter((h) => h.tier === "critical").length,
    at_risk: healths.filter((h) => h.tier === "at_risk").length,
    healthy: healths.filter((h) => h.tier === "healthy").length,
    no_data: healths.filter((h) => h.tier === "no_data").length,
    total_cash_managed: healths.reduce((s, h) => s + h.cashOnHand, 0),
    total_ar_outstanding: healths.reduce((s, h) => s + h.openAr, 0),
  };

  return {
    computedAt: new Date().toISOString(),
    clients: healths,
    summary,
  };
}
