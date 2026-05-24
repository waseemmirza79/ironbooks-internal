"use client";

import { useState } from "react";
import { ChevronDown, AlertTriangle } from "lucide-react";
import type { ProfitLossData } from "@/lib/qbo-reports";

type RangeKey = "lastMonth" | "thisMonth" | "quarter" | "ytd" | "lastYear";

/**
 * Accounting-standard section ordering. QBO's P&L report comes in this
 * order in the rows tree, but flattenRows loses that — so we re-impose it
 * here. Within each section, lines are sorted by descending absolute
 * amount so the most significant items appear first (vs alphabetical,
 * which buries the important stuff).
 */
const SECTION_ORDER = [
  "Income", "Revenue", "Sales",
  "Cost of Goods Sold", "COGS",
  "Gross Profit",
  "Operating Expenses", "Expenses", "Expense",
  "Operating Income", "Net Operating Income",
  "Other Income", "Other Expense", "Other Expenses",
  "Net Income", "Net Loss",
];

const SECTION_RANK = new Map(SECTION_ORDER.map((s, i) => [s.toLowerCase(), i]));

function sectionRank(name: string): number {
  const lower = name.toLowerCase();
  const exact = SECTION_RANK.get(lower);
  if (exact != null) return exact;
  // Substring match for variations like "Total Operating Expenses"
  for (const [key, rank] of SECTION_RANK) {
    if (lower.includes(key)) return rank;
  }
  return 999;
}

export function ProfitLossClient({
  ranges,
  data,
  closedSource,
}: {
  ranges: Record<RangeKey, { label: string; start: string; end: string }>;
  data: Record<RangeKey, ProfitLossData | null>;
  closedSource: "reclass_job_closed" | "cleanup_completed" | "calendar_default";
}) {
  const [activeRange, setActiveRange] = useState<RangeKey>("lastMonth");
  const pl = data[activeRange];
  const range = ranges[activeRange];

  const grouped = pl ? groupLines(pl.lineItems) : new Map();
  const isThisMonth = activeRange === "thisMonth";

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Profit & Loss</div>
          <h1 className="text-3xl font-bold text-navy mt-1">How you made money</h1>
          <div className="text-sm text-ink-slate mt-1">
            {range.label} · {formatDate(range.start)} → {formatDate(range.end)}
          </div>
        </div>
        <div className="flex bg-white border border-slate-200 rounded-lg p-0.5 flex-wrap">
          {(["lastMonth", "thisMonth", "quarter", "ytd", "lastYear"] as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setActiveRange(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded ${
                activeRange === k ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"
              }`}
            >
              {shortLabel(k, ranges)}
            </button>
          ))}
        </div>
      </div>

      {/* In-progress warning when viewing "this month" */}
      {isThisMonth && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <div>
            <strong>This month is still in progress.</strong> Numbers may shift as your bookkeeper
            reconciles bank feeds and posts adjustments. For a settled picture, use{" "}
            <button onClick={() => setActiveRange("lastMonth")} className="underline font-semibold">
              {ranges.lastMonth.label}
            </button>.
          </div>
        </div>
      )}

      {!pl ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          We couldn't load the P&L for this range. Try a different range or refresh — if it keeps
          happening, let your bookkeeper know.
        </div>
      ) : pl.totalIncome === 0 && pl.totalExpenses === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          No financial activity for this period.
        </div>
      ) : (
        <>
          <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
            <strong className="text-teal-dark">In plain English:</strong> You earned{" "}
            <strong>{fmtMoney(pl.totalIncome)}</strong> from sales this period and spent{" "}
            <strong>{fmtMoney(pl.totalExpenses)}</strong> on costs and overhead. That leaves{" "}
            <strong>{fmtMoney(pl.netIncome)}</strong> in profit
            {pl.totalIncome > 0 && (
              <> — about <strong>{Math.round((pl.netIncome / pl.totalIncome) * 100)}¢</strong> of every dollar you brought in</>
            )}.
          </div>

          {/* Header row with column labels */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-6 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-slate">
              <span>Category / Line</span>
              <div className="flex items-center gap-6">
                <span className="w-20 text-right">Amount</span>
                <span className="w-12 text-right">% inc</span>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {Array.from(grouped.entries())
                .sort(([a], [b]) => sectionRank(a) - sectionRank(b))
                .map(([group, lines]) => {
                  const sortedLines = [...lines].sort(
                    (a: any, b: any) => Math.abs(b.amount) - Math.abs(a.amount)
                  );
                  const groupTotal = sortedLines.reduce((s: number, l: any) => s + l.amount, 0);
                  const groupPct = pl.totalIncome > 0 ? Math.round((groupTotal / pl.totalIncome) * 100) : 0;
                  return (
                    <Section
                      key={group}
                      title={group || "Other"}
                      amount={groupTotal}
                      pct={groupPct}
                      showPct={pl.totalIncome > 0}
                    >
                      {sortedLines.map((l: any, i: number) => {
                        const linePct = pl.totalIncome > 0 ? (l.amount / pl.totalIncome) * 100 : 0;
                        return <Line key={i} label={l.label} amount={l.amount} pct={linePct} showPct={pl.totalIncome > 0} />;
                      })}
                    </Section>
                  );
                })}

              <div className="px-6 py-5 bg-teal/5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Bottom line</div>
                    <div className="text-2xl font-bold text-navy mt-1">Profit (what's left)</div>
                    {pl.totalIncome > 0 && (
                      <div className="text-xs text-ink-slate mt-1">
                        {Math.round((pl.netIncome / pl.totalIncome) * 100)}% profit margin
                      </div>
                    )}
                  </div>
                  <div className={`text-3xl font-bold ${pl.netIncome >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                    {fmtMoney(pl.netIncome)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">New to reading this?</strong> Hover any line for an explanation,
        or <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>{" "}
        any question about these numbers. The <strong>% inc</strong> column shows each line as a
        percent of total income — useful for spotting which costs are eating into your profit.
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function shortLabel(key: RangeKey, ranges: Record<RangeKey, { label: string }>): string {
  // Strip the "(April 2026)" suffix on lastMonth so the toggle button stays short
  const full = ranges[key].label;
  if (key === "lastMonth") return "Last month";
  return full;
}

function groupLines(items: ProfitLossData["lineItems"]): Map<string, ProfitLossData["lineItems"]> {
  const m = new Map<string, ProfitLossData["lineItems"]>();
  for (const item of items) {
    const g = item.group || "Other";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(item);
  }
  return m;
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Section({ title, amount, pct, showPct, children }: { title: string; amount: number; pct: number; showPct: boolean; children: React.ReactNode }) {
  return (
    <details className="px-6 py-4 group" open>
      <summary className="flex items-center justify-between cursor-pointer list-none">
        <div className="flex items-center gap-2">
          <ChevronDown size={14} className="text-ink-slate group-open:rotate-0 -rotate-90 transition-transform" />
          <div className="font-bold text-navy">{title}</div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-lg font-bold text-navy w-20 text-right">{fmtMoney(amount)}</div>
          <div className="text-xs font-semibold text-ink-slate w-12 text-right">
            {showPct ? `${pct}%` : "—"}
          </div>
        </div>
      </summary>
      <div className="mt-3 ml-6 space-y-1.5">{children}</div>
    </details>
  );
}

function Line({ label, amount, pct, showPct }: { label: string; amount: number; pct: number; showPct: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="text-ink-slate">{label}</div>
      <div className="flex items-center gap-6">
        <div className="font-mono text-navy w-20 text-right">{fmtMoney(amount)}</div>
        <div className="text-xs text-ink-light w-12 text-right font-mono">
          {showPct ? (Math.abs(pct) >= 0.5 ? `${pct.toFixed(1)}%` : "—") : "—"}
        </div>
      </div>
    </div>
  );
}
