import Link from "next/link";
import {
  TrendingUp, TrendingDown, AlertCircle, MessageSquare, ArrowRight,
  DollarSign, Receipt, Wallet, Sparkles, CheckCircle2,
} from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOverview, resolveClosedPeriod } from "@/lib/portal-data";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchPublishedPackage } from "@/lib/month-end/portal-package";
import { PortalErrorState } from "./error-state";
import { MonthEndBanner } from "./month-end-banner";
import type { PlSnapshot } from "@/lib/month-end/types";

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

  // Resolve the most-recent fully-closed accounting period. The portal
  // shows that month by default — "this month so far" is misleading
  // when the bookkeeper hasn't reconciled it yet.
  const service = createServiceSupabase();
  const closed = await resolveClosedPeriod(service, ctx.clientLinkId);
  const publishedPkg = await fetchPublishedPackage(service, ctx.clientLinkId);

  const data = await fetchOverview(
    ctx.qboRealmId,
    ctx.accessToken,
    closed.closedMonth,
    closed.priorMonth
  );

  const pkgPl = publishedPkg?.plSnapshot as PlSnapshot | undefined;
  const incomeDelta = pkgPl
    ? pkgPl.totalIncome - pkgPl.comparisonIncome
    : data.primaryPL.totalIncome - data.comparisonPL.totalIncome;
  const expensesDelta = pkgPl
    ? pkgPl.totalExpenses - pkgPl.comparisonExpenses
    : data.primaryPL.totalExpenses - data.comparisonPL.totalExpenses;
  const profitDelta = pkgPl
    ? pkgPl.netIncome - pkgPl.comparisonNetIncome
    : data.primaryPL.netIncome - data.comparisonPL.netIncome;

  const narrative = publishedPkg?.aiSummary
    ? {
        headline: `${publishedPkg.label} is closed and ready`,
        body: publishedPkg.aiSummary,
      }
    : buildHeuristicNarrative(data, profitDelta, closed.closedMonthLabel);

  const monthLabel = publishedPkg?.label || closed.closedMonthLabel;

  return (
    <div className="space-y-6">
      <MonthEndBanner />
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Good day</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Here's how your business is doing</h1>
        <div className="text-sm text-ink-slate mt-1 flex items-center gap-2 flex-wrap">
          <CheckCircle2 size={13} className="text-emerald-600" />
          <span>
            Most recent closed month: <strong className="text-navy">{monthLabel}</strong>
          </span>
          <span className="text-ink-light">·</span>
          <span className="text-ink-light">
            {publishedPkg
              ? "Delivered by your Ironbooks team"
              : closed.source === "reclass_job_closed"
              ? "Reconciled and closed by your bookkeeper"
              : closed.source === "cleanup_completed"
              ? "Most recent reconciled period"
              : "Defaulting to last calendar month"}
          </span>
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

      {/* KPI tiles — labeled by the closed month, not "this month" */}
      {(() => {
        const monthShort = data.primaryMonth.label?.split(" ")[0] || "the month";
        const prevShort = data.comparisonMonth.label?.split(" ")[0] || "prior month";
        return (
          <div className="grid grid-cols-3 gap-4">
            <KpiCard
              icon={DollarSign}
              label={`Money in (${monthShort})`}
              value={fmtMoney(data.primaryPL.totalIncome)}
              delta={incomeDelta >= 0 ? `+${fmtMoney(Math.abs(incomeDelta))} vs ${prevShort}` : `${fmtMoney(incomeDelta)} vs ${prevShort}`}
              deltaPositive={incomeDelta >= 0}
              tooltip="Total invoices and sales for work completed in this month."
            />
            <KpiCard
              icon={Receipt}
              label={`Costs (${monthShort})`}
              value={fmtMoney(data.primaryPL.totalExpenses)}
              delta={expensesDelta >= 0 ? `+${fmtMoney(Math.abs(expensesDelta))} vs ${prevShort}` : `${fmtMoney(expensesDelta)} vs ${prevShort}`}
              deltaPositive={expensesDelta < 0 /* lower costs = positive */}
              tooltip="Everything you spent — materials, subs, payroll, overhead. Higher costs aren't always bad when revenue grows faster."
            />
            <KpiCard
              icon={Wallet}
              label={`What's left (profit)`}
              value={fmtMoney(data.primaryPL.netIncome)}
              delta={profitDelta >= 0 ? `+${fmtMoney(Math.abs(profitDelta))} vs ${prevShort}` : `${fmtMoney(profitDelta)} vs ${prevShort}`}
              deltaPositive={profitDelta >= 0}
              tooltip="Money in minus costs. This is what's truly yours."
            />
          </div>
        );
      })()}

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
  profitDelta: number,
  monthLabel: string
): { headline: string; body: string } {
  const profit = data.primaryPL.netIncome;
  const income = data.primaryPL.totalIncome;
  const expenses = data.primaryPL.totalExpenses;
  const margin = income > 0 ? Math.round((profit / income) * 100) : 0;
  const monthShort = monthLabel.split(" ")[0];
  const prevShort = data.comparisonMonth.label?.split(" ")[0] || "the prior month";

  if (income === 0 && expenses === 0) {
    return {
      headline: `${monthLabel} had no recorded activity.`,
      body: `No transactions hit your books for ${monthLabel}. If you were working then, your bookkeeper may still be catching up — reach out if it seems wrong.`,
    };
  }

  let headline: string;
  if (profitDelta > 0 && profit > 0) {
    headline = `${monthShort}'s profit was up ${fmtMoney(Math.abs(profitDelta))} vs ${prevShort}.`;
  } else if (profitDelta < 0 && profit > 0) {
    headline = `${monthShort}'s profit was down ${fmtMoney(Math.abs(profitDelta))} vs ${prevShort}, but still positive.`;
  } else if (profit < 0) {
    headline = `${monthShort} ran a ${fmtMoney(Math.abs(profit))} loss.`;
  } else {
    headline = `${monthShort}'s profit was roughly flat vs ${prevShort}.`;
  }

  const body = `In ${monthLabel} you brought in ${fmtMoney(income)} and spent ${fmtMoney(expenses)} on costs and overhead, leaving ${fmtMoney(profit)} in profit. That's a ${margin}% margin — ${marginCommentary(margin)}.`;

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
