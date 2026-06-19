"use client";

import { useEffect, useState, Fragment } from "react";
import { Loader2, CalendarRange } from "lucide-react";
import type { ProfitLossByMonth } from "@/lib/qbo-pl-by-month";

function fmt(n: number): string {
  const r = Math.round(n);
  const s = Math.abs(r).toLocaleString("en-US");
  return r < 0 ? `-$${s}` : `$${s}`;
}

/**
 * Month-by-month comparative P&L: account column, one column per month (last
 * 3, current is month-to-date), and a Total column. Renders QBO's statement
 * blocks — each section's leaf accounts + a section-total row, plus the
 * summary lines (Gross Profit / Net Operating Income / Net Income).
 */
export function PLByMonthView({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<(ProfitLossByMonth & { start?: string; end?: string }) | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    fetch(`/api/clients/${clientLinkId}/pl-by-month?months=3`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        return b;
      })
      .then((b) => alive && setData(b))
      .catch((e) => alive && setError(e?.message || "Failed to load"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [clientLinkId]);

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
        <Loader2 className="animate-spin text-teal mx-auto" size={24} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900">
        Couldn&apos;t load the month-by-month P&amp;L: {error}
      </div>
    );
  }
  if (!data || data.months.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-ink-slate text-center">
        No P&amp;L data for the last 3 months.
      </div>
    );
  }

  const months = data.months;
  const colCount = months.length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs uppercase tracking-wide text-ink-slate">
              <th className="text-left font-bold px-4 py-2.5">Account</th>
              {months.map((m) => (
                <th key={m.title} className="text-right font-bold px-4 py-2.5 whitespace-nowrap">
                  {m.title}
                </th>
              ))}
              <th className="text-right font-bold px-4 py-2.5 bg-gray-100 whitespace-nowrap">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.blocks.map((block, bi) => {
              if (block.kind === "section") {
                return (
                  <Fragment key={bi}>
                    <tr className="bg-slate-50/70 border-t border-gray-200">
                      <td
                        colSpan={colCount + 2}
                        className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-slate"
                      >
                        {block.title}
                      </td>
                    </tr>
                    {block.accounts.map((a) => (
                      <tr key={a.name} className="border-t border-gray-50 hover:bg-gray-50/50">
                        <td className="px-4 py-1.5 text-navy">{a.name}</td>
                        {a.values.map((v, i) => (
                          <td key={i} className="px-4 py-1.5 text-right font-mono text-ink-slate">
                            {fmt(v)}
                          </td>
                        ))}
                        <td className="px-4 py-1.5 text-right font-mono font-semibold text-navy bg-gray-50/40">
                          {fmt(a.total)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-gray-200 bg-white">
                      <td className="px-4 py-1.5 font-bold text-navy">{block.totalLabel}</td>
                      {block.totals.map((v, i) => (
                        <td key={i} className="px-4 py-1.5 text-right font-mono font-bold text-navy">
                          {fmt(v)}
                        </td>
                      ))}
                      <td className="px-4 py-1.5 text-right font-mono font-bold text-navy bg-gray-100">
                        {fmt(block.total)}
                      </td>
                    </tr>
                  </Fragment>
                );
              }
              const isNet = /net (income|loss|earnings)/i.test(block.title);
              const niColor = isNet
                ? block.total >= 0
                  ? "text-emerald-700"
                  : "text-red-600"
                : "text-navy";
              return (
                <tr
                  key={bi}
                  className={`border-t-2 ${isNet ? "border-navy bg-navy/5" : "border-gray-200 bg-gray-50/60"}`}
                >
                  <td className={`px-4 py-2 font-bold ${isNet ? "text-navy" : "text-ink-slate"}`}>
                    {block.title}
                  </td>
                  {block.values.map((v, i) => (
                    <td key={i} className={`px-4 py-2 text-right font-mono font-bold ${niColor}`}>
                      {fmt(v)}
                    </td>
                  ))}
                  <td className={`px-4 py-2 text-right font-mono font-bold ${niColor} bg-gray-100`}>
                    {fmt(block.total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.start && data.end && (
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-ink-light flex items-center gap-1.5">
          <CalendarRange size={12} /> {data.start} → {data.end} · last 3 complete months
        </div>
      )}
    </div>
  );
}
