"use client";

import { useState } from "react";
import { HelpCircle, ChevronDown } from "lucide-react";
import type { ProfitLossData } from "@/lib/qbo-reports";

type RangeKey = "thisMonth" | "lastMonth" | "quarter" | "ytd";

export function ProfitLossClient({
  ranges,
  data,
}: {
  ranges: Record<RangeKey, { label: string; start: string; end: string }>;
  data: Record<RangeKey, ProfitLossData | null>;
}) {
  const [activeRange, setActiveRange] = useState<RangeKey>("thisMonth");
  const pl = data[activeRange];
  const range = ranges[activeRange];

  // Group line items by the QBO report's group column ("Income",
  // "Cost of Goods Sold", "Expenses", etc.) so we can section them out.
  const grouped = pl ? groupLines(pl.lineItems) : new Map();

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
        <div className="flex bg-white border border-slate-200 rounded-lg p-0.5">
          {(["thisMonth", "lastMonth", "quarter", "ytd"] as RangeKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setActiveRange(k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded ${
                activeRange === k ? "bg-teal text-white" : "text-ink-slate hover:bg-slate-50"
              }`}
            >
              {ranges[k].label}
            </button>
          ))}
        </div>
      </div>

      {!pl ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          We couldn't load the P&L for this range. Try a different range or refresh — if it keeps
          happening, let your bookkeeper know.
        </div>
      ) : pl.totalIncome === 0 && pl.totalExpenses === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          No financial activity for this period yet.
        </div>
      ) : (
        <>
          <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
            <strong className="text-teal-dark">In plain English:</strong> You earned{" "}
            <strong>{fmtMoney(pl.totalIncome)}</strong> from sales and brought in revenue this period.
            About <strong>{fmtMoney(pl.totalExpenses)}</strong> went to costs and overhead. That leaves{" "}
            <strong>{fmtMoney(pl.netIncome)}</strong> in profit
            {pl.totalIncome > 0 && (
              <> — about <strong>{Math.round((pl.netIncome / pl.totalIncome) * 100)}¢</strong> of every dollar you brought in</>
            )}.
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100">
            {Array.from(grouped.entries()).map(([group, lines]) => {
              const groupTotal = lines.reduce((s: number, l: any) => s + l.amount, 0);
              return (
                <Section key={group} title={group || "Other"} amount={groupTotal}>
                  {lines.map((l: any, i: number) => (
                    <Line key={i} label={l.label} amount={l.amount} />
                  ))}
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
        </>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-ink-slate">
        <strong className="text-navy">New to reading this?</strong> Hover any line for an explanation,
        or <a href="/portal/ask-ai" className="text-teal-dark font-semibold underline">ask the AI</a>{" "}
        any question about these numbers.
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

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

function Section({ title, amount, children }: { title: string; amount: number; children: React.ReactNode }) {
  return (
    <details className="px-6 py-4 group" open>
      <summary className="flex items-center justify-between cursor-pointer list-none">
        <div className="flex items-center gap-2">
          <ChevronDown size={14} className="text-ink-slate group-open:rotate-0 -rotate-90 transition-transform" />
          <div className="font-bold text-navy">{title}</div>
        </div>
        <div className="text-lg font-bold text-navy">{fmtMoney(amount)}</div>
      </summary>
      <div className="mt-3 ml-6 space-y-1.5">{children}</div>
    </details>
  );
}

function Line({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <div className="text-ink-slate">{label}</div>
      <div className="font-mono text-navy">{fmtMoney(amount)}</div>
    </div>
  );
}
