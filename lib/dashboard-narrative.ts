/**
 * AI-generated dashboard narrative for the portal home.
 *
 * Returns three sections — headline, summary, coaching — so the home page
 * can render each in its own visual block. The coaching section is
 * deliberately gentle and painter-specific: it identifies the single
 * biggest pain point in the client's finances and gives 3–5 sentences
 * on how to act on it.
 *
 * Caching: one row per (client_link_id, period_label) in
 * portal_dashboard_narratives. We regenerate when the closed period
 * rolls forward (next month) or when manually cleared. Within a closed
 * month, every portal visit reuses the same narrative — keeps Claude
 * costs at ~$0.05 per client per month.
 *
 * Fails soft: if Claude or the cache breaks, returns null and the
 * caller falls back to the heuristic narrative in app/portal/page.tsx.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { createClient } from "@supabase/supabase-js";
import { PORTAL_AI_SYSTEM_PROMPT } from "./portal-ai";
import type { PortalPl } from "./portal-pl";
import type { OverviewData } from "./portal-data";

const MODEL = "claude-opus-4-7";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface DashboardNarrative {
  /** One-line headline. Plain English. */
  headline: string;
  /**
   * 2–4 sentences summarizing the closed month across P&L AND the other
   * statements — A/R, A/P, cash, balance sheet posture. NOT a coaching
   * lecture; just the picture.
   */
  summary: string;
  /**
   * 3–5 sentences. The single biggest pain point in their finances + a
   * concrete next step. Painter-specific language. Gentle, not preachy.
   * Starts with what we see, then the why, then the move.
   */
  coaching: string;
}

interface NarrativeInputs {
  clientLinkId: string;
  clientName: string;
  periodLabel: string;
  periodEnd: string;
  /** Closed-month classified P&L */
  c: PortalPl;
  /** Prior-month classified P&L (for trend reference) */
  cPrior: PortalPl;
  /** Full overview data — BS, A/R, A/P, cash */
  data: OverviewData;
}

/**
 * Cached-first narrative resolver. Returns a narrative immediately on
 * cache hit; otherwise generates, caches, and returns. Returns null on
 * any error so the caller can fall back gracefully.
 */
export async function getOrGenerateDashboardNarrative(
  service: ReturnType<typeof createClient>,
  inputs: NarrativeInputs,
): Promise<DashboardNarrative | null> {
  // ── 1. Cache read ──
  try {
    const { data: cached } = await (service as any)
      .from("portal_dashboard_narratives")
      .select("narrative")
      .eq("client_link_id", inputs.clientLinkId)
      .eq("period_label", inputs.periodLabel)
      .maybeSingle();
    if (cached?.narrative && typeof cached.narrative === "object") {
      const n = cached.narrative as Partial<DashboardNarrative>;
      if (n.headline && n.summary && n.coaching) {
        return n as DashboardNarrative;
      }
    }
  } catch {
    // cache miss is silent — fall through to generation
  }

  // ── 2. Generate ──
  try {
    const narrative = await generateNarrative(inputs);
    // ── 3. Cache write — best-effort ──
    try {
      await (service as any)
        .from("portal_dashboard_narratives")
        .upsert(
          {
            client_link_id: inputs.clientLinkId,
            period_label: inputs.periodLabel,
            period_end: inputs.periodEnd,
            narrative,
            model: MODEL,
            generated_at: new Date().toISOString(),
          },
          { onConflict: "client_link_id,period_label" }
        );
    } catch {
      // Cache write failure is non-fatal — narrative still returned.
    }
    return narrative;
  } catch (e) {
    console.warn("[dashboard-narrative] generation failed:", (e as Error)?.message);
    return null;
  }
}

async function generateNarrative(inputs: NarrativeInputs): Promise<DashboardNarrative> {
  const { c, cPrior, data, periodLabel, clientName } = inputs;
  const banks = data.banks;

  // Build a compact, dense context. Claude works better with structured
  // bullets than prose dumps. We round currency to dollars (cents add
  // noise to a strategic narrative).
  const r = (n: number) => Math.round(n);

  const context = {
    period: periodLabel,
    business: clientName,
    profit_and_loss_closed_month: {
      revenue: r(c.totalIncome),
      direct_job_costs: r(c.totalVariable),
      gross_profit: r(c.grossProfit),
      gross_margin_pct: Math.round(c.grossMarginPct),
      overhead: r(c.totalFixed),
      net_profit: r(c.netProfit),
      net_margin_pct: Math.round(c.netMarginPct),
      cost_split_estimated: c.costSplitEstimated,
      top_expense_lines: c.fixedExpenses.lines
        .slice()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map((l) => ({ label: l.label, amount: r(l.amount), pct_of_income: Math.round(l.pctOfIncome) })),
    },
    prior_month: {
      revenue: r(cPrior.totalIncome),
      gross_profit: r(cPrior.grossProfit),
      net_profit: r(cPrior.netProfit),
      gross_margin_pct: Math.round(cPrior.grossMarginPct),
      net_margin_pct: Math.round(cPrior.netMarginPct),
    },
    cash: {
      total_in_bank_accounts: r(banks.totalCashOnHand),
      total_credit_card_debt: r(banks.totalCreditCardDebt),
      bank_accounts: banks.accounts.map((a) => ({
        name: a.name,
        balance: r(a.balance),
        type: a.type,
      })),
    },
    accounts_receivable: {
      total_open: r(data.openARTotal),
      total_overdue: r(data.overdueARTotal),
      overdue_invoice_count: data.overdueARCount,
      total_invoice_count: data.openARCount,
    },
    accounts_payable: {
      total_owed: r(data.openAPTotal),
      bill_count: data.openAPCount,
    },
  };

  const userPrompt = `Generate the closed-month dashboard narrative for this painting contractor.

CONTEXT:
${JSON.stringify(context, null, 2)}

Respond with ONLY a JSON object in this exact shape, no prose, no markdown fences:
{
  "headline": "one-line headline, plain English, no jargon, ≤90 chars",
  "summary": "2–4 sentences summarizing the closed month across P&L, A/R, A/P, and cash. Specific numbers from the context. NOT a coaching lecture — just the picture of what happened.",
  "coaching": "3–5 sentences. Identify the SINGLE biggest pain point in their finances right now (could be margin, overhead creep, A/R pile-up, cash crunch, or a specific over-target line). Use the painter benchmarks in your system prompt. Tone is gentle and confident — they're the operator, you're the trusted advisor. Format: name what you see → name why it matters → one concrete next step they can take this week. Cite specific dollar amounts from the context. End with the action, not a hedge."
}

Hard rules:
- Numbers MUST come from the context. Never invent figures.
- Compare to the painter benchmarks in your system prompt, not generic small-business norms.
- Do not name specific people, vendors, or brands.
- No legal/tax advice — redirect to CPA if it comes up.
- If the books look healthy, the coaching section is about the NEXT level (e.g. "GP is on target at 52% — the next lever is overhead, currently 36% vs 30% target.") — not generic praise.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: PORTAL_AI_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<DashboardNarrative>;

  if (!parsed.headline || !parsed.summary || !parsed.coaching) {
    throw new Error("Claude output missing required fields");
  }
  return {
    headline: String(parsed.headline).slice(0, 200),
    summary: String(parsed.summary),
    coaching: String(parsed.coaching),
  };
}
