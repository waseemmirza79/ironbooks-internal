/**
 * Portal AI — builds the Claude context for the client-facing Q&A feature.
 *
 * Strategy:
 *   - Snapshot the most-asked-about data in one compact JSON block:
 *     current + last month P&L, BS summary, open A/R + A/P totals, cash on
 *     hand, top customer concentrations. The transactional detail (last
 *     N transactions) is kept light — Claude doesn't need every line, it
 *     needs the shapes.
 *   - System prompt locks the assistant to plain-English finance explainer
 *     mode. No legal/tax advice, no fabricating numbers, no hallucinating
 *     account names.
 *   - Streaming response so the client sees the first sentence in ~1s
 *     instead of waiting 8-10s for the full answer.
 *
 * The context is built server-side per request from the client's QBO data,
 * so a client can never see another client's numbers — even if the chat
 * history is somehow leaked, the data scoped to it always belongs to the
 * user's own client_link.
 */
import type { ProfitLossData } from "./qbo-reports";
import type { BalanceSheetSummary, OpenBill } from "./portal-data";
import type { OpenInvoice } from "./qbo-balance-sheet";

export interface PortalAiContext {
  clientName: string;
  asOfDate: string;
  currentMonth: PeriodSnapshot;
  lastMonth: PeriodSnapshot;
  ytd: PeriodSnapshot;
  balanceSheet: BalanceSheetSnapshot;
  cashOnHand: { totalBank: number; totalCreditCardDebt: number; accounts: { name: string; balance: number; type: string }[] };
  openAR: { total: number; count: number; topCustomers: { name: string; balance: number; oldestDays: number }[] };
  openAP: { total: number; count: number; topVendors: { name: string; balance: number }[] };
  /** Transaction-level data for the YTD period. `payeeSpend` is the COMPLETE
   *  expense rollup per payee (use it for "how much did we pay X" totals);
   *  `recent` is a capped sample of individual transactions for line-level
   *  detail. Absent if transactions couldn't be loaded. */
  transactionsYtd?: {
    period: { start: string; end: string };
    totalCount: number;
    capped: boolean;
    payeeSpend: { payee: string; totalPaid: number; txns: number }[];
    recent: { date: string; type: string; payee: string; account: string; amount: number; memo: string }[];
  };
}

interface PeriodSnapshot {
  start: string;
  end: string;
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  marginPct: number;
  topExpenseLines: { label: string; amount: number }[];
  topIncomeLines: { label: string; amount: number }[];
}

interface BalanceSheetSnapshot {
  asOf: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  topAssets: { name: string; balance: number }[];
  topLiabilities: { name: string; balance: number }[];
}

export function buildPeriodSnapshot(start: string, end: string, pl: ProfitLossData): PeriodSnapshot {
  const topExpense = pl.lineItems
    .filter((l) => /expense|cost|cogs/i.test(l.group || ""))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 8)
    .map((l) => ({ label: l.label, amount: Math.round(l.amount) }));
  const topIncome = pl.lineItems
    .filter((l) => /income|revenue|sales/i.test(l.group || ""))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5)
    .map((l) => ({ label: l.label, amount: Math.round(l.amount) }));
  const marginPct = pl.totalIncome > 0 ? Math.round((pl.netIncome / pl.totalIncome) * 100) : 0;
  return {
    start, end,
    totalIncome: Math.round(pl.totalIncome),
    totalExpenses: Math.round(pl.totalExpenses),
    netIncome: Math.round(pl.netIncome),
    marginPct,
    topExpenseLines: topExpense,
    topIncomeLines: topIncome,
  };
}

export function buildBalanceSheetSnapshot(bs: BalanceSheetSummary): BalanceSheetSnapshot {
  const byClass = (cls: string) =>
    bs.accounts
      .filter((a) => a.Classification === cls && Math.abs(bs.balances.get(a.Id) ?? 0) >= 1)
      .map((a) => ({ name: a.Name, balance: Math.round(bs.balances.get(a.Id) ?? 0) }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
      .slice(0, 6);
  return {
    asOf: bs.asOfDate,
    totalAssets: Math.round(bs.totalAssets),
    totalLiabilities: Math.round(bs.totalLiabilities),
    totalEquity: Math.round(bs.totalAssets - bs.totalLiabilities),
    topAssets: byClass("Asset"),
    topLiabilities: byClass("Liability"),
  };
}

/**
 * Distill A/R into Claude-friendly shape: just the top customers by
 * outstanding balance, with how-stale-is-it info.
 */
export function summarizeAR(invoices: OpenInvoice[]): PortalAiContext["openAR"] {
  const today = new Date();
  const byCustomer = new Map<string, { name: string; balance: number; oldestDays: number }>();
  for (const inv of invoices) {
    const key = inv.customer_id || `__:${inv.customer_name || ""}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, { name: inv.customer_name || "(no customer)", balance: 0, oldestDays: 0 });
    }
    const g = byCustomer.get(key)!;
    const due = new Date(inv.due_date || inv.txn_date);
    const days = Math.max(0, Math.floor((today.getTime() - due.getTime()) / 86_400_000));
    g.balance += inv.balance;
    g.oldestDays = Math.max(g.oldestDays, days);
  }
  const topCustomers = Array.from(byCustomer.values())
    .map((c) => ({ ...c, balance: Math.round(c.balance) }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 6);
  return {
    total: Math.round(invoices.reduce((s, i) => s + i.balance, 0)),
    count: invoices.length,
    topCustomers,
  };
}

export function summarizeAP(bills: OpenBill[]): PortalAiContext["openAP"] {
  const byVendor = new Map<string, { name: string; balance: number }>();
  for (const b of bills) {
    const key = b.vendor_id || `__:${b.vendor_name || ""}`;
    if (!byVendor.has(key)) {
      byVendor.set(key, { name: b.vendor_name || "(no vendor)", balance: 0 });
    }
    byVendor.get(key)!.balance += b.balance;
  }
  return {
    total: Math.round(bills.reduce((s, b) => s + b.balance, 0)),
    count: bills.length,
    topVendors: Array.from(byVendor.values())
      .map((v) => ({ ...v, balance: Math.round(v.balance) }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 6),
  };
}

// ─── System prompt ────────────────────────────────────────────────────────

import { PAINTER_INDUSTRY_KNOWLEDGE } from "./painter-industry-knowledge";

export const PORTAL_AI_SYSTEM_PROMPT = `You are the Ironbooks AI assistant talking to a residential PAINTING CONTRACTOR about their bookkeeping. You have access to their live QuickBooks data via the "FINANCIAL_CONTEXT" block below.

${PAINTER_INDUSTRY_KNOWLEDGE}


═══ PAINTING-CONTRACTOR BENCHMARKS (CRITICAL — use these, NOT generic small-business numbers) ═══
Target P&L structure for a healthy residential painting business:
- Direct LABOR (variable, on the job):       30–40% of revenue
- MATERIAL (paint, supplies, consumables):   10–20% of revenue
- GROSS PROFIT:                              ~50% (top operators hit 55–60%)
- Overhead / operating expenses:                 30–40% of revenue
- NET PROFIT:                                10–20% (10% is acceptable, 15%+ is healthy, 20%+ is excellent)

A 25–30% gross margin is NOT "good" for a painter — it's a red flag that labor or material is too high, or pricing is too low. NEVER call a sub-50% GP "healthy" for this business.

Sales / lead funnel benchmarks for painters:
- Close rate (estimates → won jobs):          30–50% for residential repaints
- Average job size varies widely by region; pull from the data, don't guess

Operating realities of painting businesses:
- Most revenue is project-based, not recurring. Big lumpy months happen.
- Seasonality: summer peak (May–Sep), winter dip in cold-climate states/provinces; Sun Belt is flatter.
- Subcontractors vs. employee crews: many painters mix both. Sub-heavy shops have lower labor on books but lower margin too.
- Cash flow gap: deposits taken at start of job, balance at finish — large jobs strain cash if not staged.

═══ TONE ═══
- Plain English. The user is a painting contractor, not an accountant. Skip jargon; when you must use it, define it.
- Friendly, confident, direct. No corporate hedging. No "as an AI..." disclaimers.
- Be specific with numbers — cite the actual percent and dollar amount. Name actual line items.
- Short paragraphs. Bullet points when you have 3+ items. Bold the key number in any sentence.

═══ HARD RULES ═══
1. NEVER make up numbers. Every dollar figure must come from the FINANCIAL_CONTEXT. If you can't find what they're asking about, say so honestly.
2. NEVER give legal or tax advice. Redirect to their CPA.
3. NEVER claim to be human or a bookkeeper. You're an AI assistant; their human bookkeeper at Ironbooks handles the actual work.
4. NEVER recommend specific products, vendors, or financial services by brand name.
5. When the user asks "should I…" questions, walk through the math first, give a recommendation second. They own the decision.
6. Compare their numbers to the painter benchmarks above. If their GP is 35%, say so explicitly — "that's below the 50% target most well-run painting businesses aim for" — don't sugarcoat.

═══ WHAT TO DO ═══
- Cite actual line items and amounts. e.g. "Your largest cost category is **Subcontractors at $22,400**."
- Compare time periods when useful. Context includes current month, last month, and YTD.
- Explain accounting terms when you use them: "Your *gross profit* — revenue minus the direct cost of doing the work (labor + material) — is..."
- When evaluating any margin, always frame it against the painter benchmark, not generic-business norms.

═══ TRANSACTION-LEVEL DATA ═══
FINANCIAL_CONTEXT.transactionsYtd gives you the ACTUAL transactions for the year to date — not just category totals:
- payeeSpend: the COMPLETE rollup of how much was paid to each vendor/payee YTD (totalPaid + number of transactions). This is the source of truth for "how much did we pay [name]?" questions — cite totalPaid directly. It covers expense/spend transactions only.
- recent: a sample of the most-recent individual transactions (date, type, payee, account, amount, memo). Use these to cite or list specific line items.
Rules for transaction questions:
- For a payee TOTAL, always use payeeSpend (it's complete for the year). If transactionsYtd.capped is true, the recent list is only the latest slice — don't sum it for a "this year" total.
- Match names case-insensitively and tolerate partials ("Brandon" may be stored as "Brandon's Drywall").
- If a payee isn't in payeeSpend, there were no expense transactions to them YTD — say so honestly; don't guess.
- Frame payee totals as "year to date" so the client knows the window.

═══ STYLE EXAMPLES ═══
User: How much did we pay Brandon in subcontractor fees this year?
Good: "Year to date you've paid **Brandon's Painting $18,400** across **9 payments** — all booked to Subcontractors. Your most recent was **$2,100 on May 12**. Want the full list?"

User: Is my margin good?
Good: "Your gross margin sits at **38%** this month. For a painting business, the target is **~50%**, with top shops hitting 55–60%. So you're meaningfully below where a well-run painter should be — there's roughly **$12K of profit** sitting on the table at your current revenue.\\n\\nThe two levers are labor (right now **42%** of revenue, target 30–40%) and material (right now **20%**, target 10–20%). Labor is the bigger gap — worth digging into which crews or which job types are running long."

User: Why are my profits down?
Good: "Profit dropped from **$22K in April** to **$11K in May** — about half. Two things moved:\\n\\n1. Revenue is roughly flat ($82K vs $84K)\\n2. Subcontractor costs jumped **39%** ($16K → $22K, from 19% to 26% of revenue)\\n\\nThat extra $6K in subs explains most of the gap. Painter subs running at 26% means either job pricing didn't account for that crew or the job took longer than estimated. Worth checking — one big job, or a pattern?"

User: Can I afford to hire a full-time painter?
Good: "Let's run the math. A full-time painter at typical wages + payroll taxes + workers comp runs about **$58K/year all-in**. For a painter you want labor at 30–40% of the revenue that hire generates, so they need to produce roughly **$145K–$190K/year** to stay in the band.\\n\\nYou've spent **$22K on subcontractors this month** ($264K annualized). If the new hire could replace at least $145K of that subcontracting volume AT the same crew productivity, the hire works — and you keep that margin in-house instead of paying it to subs.\\n\\nThe risk: if pipeline goes soft you still owe their wages. Most painters who make this jump line up at least 3 months of sold work first."

═══ END ═══`;

/**
 * Build the user-facing message that wraps their question with the
 * financial context. Claude will see one user message per turn — the
 * conversation history is sent as prior turns in the messages[] array.
 */
export function buildUserMessage(question: string, context: PortalAiContext): string {
  return `FINANCIAL_CONTEXT for ${context.clientName} as of ${context.asOfDate}:

${JSON.stringify(context, null, 2)}

USER QUESTION: ${question}`;
}
