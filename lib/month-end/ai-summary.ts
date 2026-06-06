import Anthropic from "@anthropic-ai/sdk";
import type {
  PlSnapshot,
  BsSnapshot,
  ArApSnapshot,
  DailyReconStats,
  PeriodBounds,
} from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

export interface SummaryInput {
  clientName: string;
  industry?: string | null;
  jurisdiction?: string | null;
  period: PeriodBounds;
  pl: PlSnapshot;
  bs: BsSnapshot;
  arAp: ArApSnapshot;
  dailyRecon: DailyReconStats;
}

function pctDelta(current: number, prior: number): string {
  if (prior === 0) return current === 0 ? "unchanged" : "new activity";
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  if (pct === 0) return "unchanged";
  return `${pct > 0 ? "+" : ""}${pct}% vs prior month`;
}

export async function generateMonthEndSummary(input: SummaryInput): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return buildFallbackSummary(input);
  }

  const facts = {
    client: input.clientName,
    industry: input.industry || "small business",
    jurisdiction: input.jurisdiction || "US",
    period: input.period.label,
    profit_and_loss: {
      income: input.pl.totalIncome,
      expenses: input.pl.totalExpenses,
      net_income: input.pl.netIncome,
      income_vs_prior: pctDelta(input.pl.totalIncome, input.pl.comparisonIncome),
      expenses_vs_prior: pctDelta(input.pl.totalExpenses, input.pl.comparisonExpenses),
      net_vs_prior: pctDelta(input.pl.netIncome, input.pl.comparisonNetIncome),
      top_income: input.pl.topIncomeLines.slice(0, 5),
      top_expenses: input.pl.topExpenseLines.slice(0, 5),
    },
    balance_sheet: {
      as_of: input.bs.asOfDate,
      assets: input.bs.totalAssets,
      liabilities: input.bs.totalLiabilities,
      equity: input.bs.totalEquity,
      cash_on_hand: input.bs.cashOnHand,
      top_assets: input.bs.topAssets,
      top_liabilities: input.bs.topLiabilities,
    },
    ar_ap: input.arAp,
    daily_recon: input.dailyRecon,
  };

  const system = `You write plain-English month-end summaries for small business owners (often trades like painting contractors).
Rules:
- Use ONLY the numbers provided in the facts JSON. Never invent figures.
- 3-5 short paragraphs max. Warm, direct, no jargon.
- Explain what changed and why it matters to THEIR business.
- No tax, legal, or filing advice.
- Mention daily recon stats if non-zero (auto-categorized transactions).`;

  let response: Awaited<ReturnType<typeof client.messages.create>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 900,
        system,
        messages: [
          {
            role: "user",
            content: `Write the month-end summary for ${input.clientName}.\n\nFACTS:\n${JSON.stringify(facts, null, 2)}`,
          },
        ],
      });
      break;
    } catch (err: any) {
      const overloaded = /overloaded|529|rate_limit/i.test(err?.message || "");
      if (!overloaded || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 4000));
    }
  }
  if (!response) return buildFallbackSummary(input);

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  return text || buildFallbackSummary(input);
}

function buildFallbackSummary(input: SummaryInput): string {
  const { pl, bs, period, clientName } = input;
  const incomeDir = pl.totalIncome >= pl.comparisonIncome ? "up" : "down";
  const profitDir = pl.netIncome >= pl.comparisonNetIncome ? "stronger" : "tighter";
  return [
    `Your books for ${period.label} are closed and ready to review, ${clientName}.`,
    `Revenue came in at $${pl.totalIncome.toLocaleString()}, ${incomeDir} from the prior month. Expenses were $${pl.totalExpenses.toLocaleString()}, leaving net income of $${pl.netIncome.toLocaleString()} — a ${profitDir} month overall.`,
    `Cash and bank balances total about $${bs.cashOnHand.toLocaleString()} as of ${bs.asOfDate}. Open receivables are $${input.arAp.openARTotal.toLocaleString()} across ${input.arAp.openARCount} invoices.`,
    `Log in to your Ironbooks portal for the full profit & loss and balance sheet for ${period.label}.`,
  ].join("\n\n");
}
