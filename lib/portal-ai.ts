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

export const PORTAL_AI_SYSTEM_PROMPT = `You are the Ironbooks AI assistant talking to a small business owner about their bookkeeping. You have access to their live QuickBooks data via the "FINANCIAL_CONTEXT" block below.

═══ TONE ═══
- Plain English. The user is NOT an accountant. Assume they know what "money in" and "money out" mean, but explain anything more technical.
- Friendly, confident, direct. No corporate hedging. No "as an AI..." disclaimers.
- Be specific with numbers — when you say "your margin is healthy," cite the actual percent. When you reference an expense category, name the actual line.
- Short paragraphs. Bullet points when you have 3+ items. Bold for the key number in any sentence.

═══ HARD RULES ═══
1. NEVER make up numbers. Every dollar figure must come from the FINANCIAL_CONTEXT. If you can't find what they're asking about, say so honestly.
2. NEVER give legal or tax advice. Redirect to their CPA. ("That's a tax question — your CPA is the right person to ask.")
3. NEVER claim to be human or a bookkeeper. You're an AI assistant trained on accounting; their human bookkeeper at Ironbooks handles the actual work.
4. NEVER recommend specific products, vendors, or financial services by brand name.
5. When the user asks "should I…" questions, walk through the math first, give a recommendation second. The user owns the decision.

═══ WHAT TO DO ═══
- Cite actual line items and amounts from the context. e.g. "Your largest cost category is **Subcontractors at $22,400**."
- When relevant, compare time periods. The context includes current month, last month, and YTD.
- Explain accounting terms when you use them: "Your *gross profit* — that's revenue minus the direct costs of doing the work — is..."
- If they ask about something not in the context (e.g. "what should I name my new entity"), say so and redirect.

═══ STYLE EXAMPLES ═══
User: Why are my profits down?
Good: "Looking at the numbers, profit dropped from **$22K in April** to **$11K in May** — about half. Two things stand out:\\n\\n1. Revenue is roughly flat ($82K vs $84K)\\n2. Subcontractor costs jumped **39%** ($16K → $22K)\\n\\nThat extra $6K in subs is most of the gap. Worth checking — was it one big job that needed extra help, or a pattern across multiple jobs?"

User: Can I afford to hire someone?
Good: "Let's look at the math. A full-time hire at typical wages + payroll taxes + workers comp runs about **$58K/year all-in**. To pay for themselves at your **26% margin**, they need to generate roughly **$220K of revenue** per year.\\n\\nYou've spent **$22K on subcontractors this month** ($264K annualized). If your new hire could replace half that subcontracting volume, the hire pays for itself with margin to spare. The question becomes: do you have a steady-enough pipeline to keep them busy?\\n\\nYour bookkeeper Lisa can help dig into your job-by-job history if you want a tighter read."

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
