import Link from "next/link";
import {
  TrendingUp, TrendingDown, AlertCircle, MessageSquare, ArrowRight,
  DollarSign, Receipt, Wallet, Sparkles,
} from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOverview } from "@/lib/portal-data";
import { PortalErrorState } from "./error-state";

/**
 * Portal Overview — live data version.
 *
 * Renders the client's financial health summary by pulling live QBO data:
 *   - This month + last month P&L (for the delta callouts)
 *   - All bank/CC balances for cash-on-hand
 *   - Open A/R + overdue summary
 *   - Open A/P (for the future "what you owe" link)
 *
 * The narrative line at the top is heuristic for now ("up vs last month")
 * — Day 6 wires Claude to generate a real plain-English summary.
 */
export const dynamic = "force-dynamic";

export default async function PortalOverview() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  }
  const { ctx } = ctxResult;

  const data = await fetchOverview(ctx.qboRealmId, ctx.accessToken);

  const incomeDelta = data.currentMonthPL.totalIncome - data.lastMonthPL.totalIncome;
  const expensesDelta = data.currentMonthPL.totalExpenses - data.lastMonthPL.totalExpenses;
  const profitDelta = data.currentMonthPL.netIncome - data.lastMonthPL.netIncome;

  // Heuristic narrative — Day 6 swaps in Claude
  const narrative = buildHeuristicNarrative(data, profitDelta);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Good day</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Here's how your business is doing</h1>
        <div className="text-sm text-ink-slate mt-1">
          As of {formatDate(data.asOfDate)} · Updated daily from QuickBooks
        </div>
      </div>

      {/* Big health summary */}
      <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-6">
        <div className="flex items-start gap-3 mb-3">
          <Sparkles size={20} className="text-teal-dark mt-0.5" />
          <div className="flex-1">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">This month at a glance</div>
            <h2 className="text-lg font-bold text-navy mt-1">{narrative.headline}</h2>
          </div>
        </div>
        <p className="text-sm text-navy/80 leading-relaxed">{narrative.body}</p>
        <div className="mt-4">
          <Link
            href="/portal/ask-ai"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
          >
            <MessageSquare size={12} />
            Ask the AI to explain more
          </Link>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard
          icon={DollarSign}
          label="Money in this month"
          value={fmtMoney(data.currentMonthPL.totalIncome)}
          delta={incomeDelta >= 0 ? `+${fmtMoney(Math.abs(incomeDelta))} vs last month` : `${fmtMoney(incomeDelta)} vs last month`}
          deltaPositive={incomeDelta >= 0}
          tooltip="Total invoices and sales for work completed this month."
        />
        <KpiCard
          icon={Receipt}
          label="Costs this month"
          value={fmtMoney(data.currentMonthPL.totalExpenses)}
          delta={expensesDelta >= 0 ? `+${fmtMoney(Math.abs(expensesDelta))} vs last month` : `${fmtMoney(expensesDelta)} vs last month`}
          deltaPositive={expensesDelta < 0 /* lower costs = positive */}
          tooltip="Everything you spent — materials, subs, payroll, overhead. Higher costs aren't always bad when revenue grows faster."
        />
        <KpiCard
          icon={Wallet}
          label="What's left (profit)"
          value={fmtMoney(data.currentMonthPL.netIncome)}
          delta={profitDelta >= 0 ? `+${fmtMoney(Math.abs(profitDelta))} vs last month` : `${fmtMoney(profitDelta)} vs last month`}
          deltaPositive={profitDelta >= 0}
          tooltip="Money in minus costs. This is what's truly yours."
        />
      </div>

      {/* Attention items */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-navy">What needs your attention</h3>
        </div>
        <div className="space-y-3">
          {data.overdueARCount > 0 ? (
            <AttentionItem
              color="red"
              icon={AlertCircle}
              title={`${fmtMoney(data.overdueARTotal)} overdue from customers`}
              body={`${data.overdueARCount} invoice${data.overdueARCount === 1 ? "" : "s"} past due. Tap below to see who and how late.`}
              cta="See who owes you"
              href="/portal/whos-paying"
            />
          ) : (
            <AttentionItem
              color="teal"
              icon={TrendingUp}
              title="All customer payments are current"
              body="Nothing overdue — nice work staying on top of A/R."
              cta="View A/R"
              href="/portal/whos-paying"
            />
          )}
          {data.openAPTotal > 0 && (
            <AttentionItem
              color="amber"
              icon={Receipt}
              title={`${fmtMoney(data.openAPTotal)} in unpaid bills`}
              body={`${data.openAPCount} bill${data.openAPCount === 1 ? "" : "s"} outstanding to vendors. Check what's due soon.`}
              cta="See what you owe"
              href="/portal/whats-due"
            />
          )}
          {data.openARCount === 0 && data.openAPCount === 0 && data.overdueARCount === 0 && (
            <div className="text-sm text-ink-slate italic">
              Nothing pressing. Your books look clean.
            </div>
          )}
        </div>
      </div>

      {/* Cash on hand */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <h3 className="font-bold text-navy mb-3">Cash on hand</h3>
        {data.banks.accounts.length === 0 ? (
          <div className="text-sm text-ink-slate italic">
            No bank or credit card accounts found in QuickBooks.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {data.banks.accounts.slice(0, 6).map((a) => (
                <CashTile
                  key={a.name}
                  label={a.name}
                  amount={fmtMoney(a.balance)}
                  sub={a.type === "credit_card" ? "Credit card" : "Bank"}
                  negative={a.type === "credit_card" || a.balance < 0}
                />
              ))}
            </div>
            <div className="mt-3 text-xs text-ink-slate">
              Total cash available:{" "}
              <strong className="text-navy">{fmtMoney(data.banks.totalCashOnHand)}</strong>
              {data.banks.totalCreditCardDebt > 0 && (
                <>
                  {" "}· Credit card debt:{" "}
                  <strong className="text-red-700">{fmtMoney(data.banks.totalCreditCardDebt)}</strong>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDate(yyyyMMdd: string): string {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function buildHeuristicNarrative(
  data: Awaited<ReturnType<typeof fetchOverview>>,
  profitDelta: number
): { headline: string; body: string } {
  const profit = data.currentMonthPL.netIncome;
  const income = data.currentMonthPL.totalIncome;
  const expenses = data.currentMonthPL.totalExpenses;
  const margin = income > 0 ? Math.round((profit / income) * 100) : 0;

  if (income === 0 && expenses === 0) {
    return {
      headline: "No activity this month yet.",
      body: "We haven't seen any transactions hit your books this month. If you've been working, your bookkeeper may still be catching up — reach out if it's been more than a few days.",
    };
  }

  let headline: string;
  if (profitDelta > 0 && profit > 0) {
    headline = `You're up ${fmtMoney(Math.abs(profitDelta))} in profit vs last month.`;
  } else if (profitDelta < 0 && profit > 0) {
    headline = `Profit is down ${fmtMoney(Math.abs(profitDelta))} vs last month, but still positive.`;
  } else if (profit < 0) {
    headline = `You're running a ${fmtMoney(Math.abs(profit))} loss so far this month.`;
  } else {
    headline = `Profit is roughly flat vs last month.`;
  }

  const body = `You brought in ${fmtMoney(income)} this month and spent ${fmtMoney(expenses)} on costs and overhead, leaving ${fmtMoney(profit)} in profit. That's a ${margin}% margin — ${marginCommentary(margin)}.`;

  return { headline, body };
}

function marginCommentary(pct: number): string {
  if (pct >= 25) return "healthy for most service businesses";
  if (pct >= 15) return "solid, with room to optimize";
  if (pct >= 5) return "thin — worth digging into where costs are going";
  if (pct >= 0) return "very thin — let's look at pricing or cost control";
  return "negative this month — your bookkeeper can help diagnose where";
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, delta, deltaPositive, tooltip,
}: { icon: any; label: string; value: string; delta: string; deltaPositive: boolean; tooltip: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className="text-ink-slate" />
        <span className="text-xs font-semibold text-ink-slate uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-navy mt-2">{value}</div>
      <div className={`text-xs mt-1 ${deltaPositive ? "text-emerald-700" : "text-amber-700"}`}>
        {deltaPositive ? <TrendingUp size={11} className="inline mr-0.5" /> : <TrendingDown size={11} className="inline mr-0.5" />}
        {delta}
      </div>
      <div className="mt-3 text-[11px] text-ink-light italic leading-relaxed">{tooltip}</div>
    </div>
  );
}

function AttentionItem({
  color, icon: Icon, title, body, cta, href,
}: { color: "red" | "amber" | "teal"; icon: any; title: string; body: string; cta: string; href: string }) {
  const colors = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    teal: "bg-teal/5 border-teal/30 text-teal-dark",
  }[color];
  return (
    <div className={`flex items-start gap-3 p-3 border rounded-lg ${colors}`}>
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="font-semibold text-sm">{title}</div>
        <div className="text-xs mt-0.5 opacity-80">{body}</div>
      </div>
      <Link href={href} className="text-xs font-semibold flex items-center gap-1 hover:underline">
        {cta} <ArrowRight size={11} />
      </Link>
    </div>
  );
}

function CashTile({ label, amount, sub, negative }: { label: string; amount: string; sub: string; negative?: boolean }) {
  return (
    <div>
      <div className="text-xs text-ink-slate truncate" title={label}>{label}</div>
      <div className={`text-xl font-bold ${negative ? "text-red-700" : "text-navy"}`}>{amount}</div>
      <div className="text-[11px] text-ink-light">{sub}</div>
    </div>
  );
}
