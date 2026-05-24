import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOpenBills, ageBills, summarizeBanks } from "@/lib/portal-data";
import { fetchAllAccounts } from "@/lib/qbo";
import { PortalErrorState } from "../error-state";
import { Calendar } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * "What you owe" — live A/P aging + a cash-flow comfort check.
 *
 * The cash-flow line at the top compares cash on hand to upcoming bills.
 * If the ratio is tight, the language nudges the user to look closer.
 */
export default async function WhatsDuePage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const [bills, accounts] = await Promise.all([
    fetchOpenBills(ctx.qboRealmId, ctx.accessToken).catch(() => []),
    fetchAllAccounts(ctx.qboRealmId, ctx.accessToken).catch(() => []),
  ]);

  const aging = ageBills(bills);
  const banks = summarizeBanks(accounts);

  // 30-day due window for the cash-flow check
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const dueSoon = bills
    .filter((b) => {
      if (!b.due_date) return false;
      const due = new Date(b.due_date);
      return due >= now && due <= in30;
    })
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
  const dueSoonTotal = dueSoon.reduce((s, b) => s + b.balance, 0);

  // Vendor aggregation
  const byVendor = new Map<string, { name: string; total: number; bills: number; oldestDays: number }>();
  for (const b of bills) {
    const key = b.vendor_id || `__name:${b.vendor_name || "(no vendor)"}`;
    if (!byVendor.has(key)) {
      byVendor.set(key, { name: b.vendor_name || "(no vendor)", total: 0, bills: 0, oldestDays: 0 });
    }
    const g = byVendor.get(key)!;
    const txnDate = new Date(b.txn_date);
    const daysOld = Math.floor((now.getTime() - txnDate.getTime()) / 86_400_000);
    g.total += b.balance;
    g.bills++;
    g.oldestDays = Math.max(g.oldestDays, daysOld);
  }
  const vendors = Array.from(byVendor.values()).sort((a, b) => b.total - a.total);

  const cashRatio = banks.totalCashOnHand > 0 ? dueSoonTotal / banks.totalCashOnHand : 0;
  const cashHealthy = cashRatio < 0.5;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Bills & obligations</div>
        <h1 className="text-3xl font-bold text-navy mt-1">What you owe</h1>
        <div className="text-sm text-ink-slate mt-1">
          {fmtMoney(aging.totalAmount)} total · {fmtMoney(dueSoonTotal)} due in the next 30 days
        </div>
      </div>

      {bills.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
          No outstanding bills — you're all caught up.
        </div>
      ) : (
        <>
          <div className={`border rounded-xl p-4 text-sm leading-relaxed ${
            cashHealthy
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-amber-50 border-amber-200 text-amber-900"
          }`}>
            <strong>Cash flow check:</strong> You have{" "}
            <strong>{fmtMoney(banks.totalCashOnHand)}</strong> in the bank and{" "}
            <strong>{fmtMoney(dueSoonTotal)}</strong> in bills due in the next 30 days.{" "}
            {cashHealthy
              ? "You're in good shape — plenty of room for payroll and operating expenses."
              : "Tighter than ideal — keep an eye on this and prioritize the urgent bills."}
          </div>

          {dueSoon.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="font-bold text-navy mb-3">Due in the next 30 days</h3>
              <div className="space-y-2">
                {dueSoon.slice(0, 15).map((b) => {
                  const due = new Date(b.due_date!);
                  const daysAway = Math.max(0, Math.floor((due.getTime() - now.getTime()) / 86_400_000));
                  const urgent = daysAway <= 7;
                  return (
                    <BillRow
                      key={b.qbo_bill_id}
                      payee={b.vendor_name || "Unknown vendor"}
                      due={formatDate(b.due_date!)}
                      daysAway={daysAway}
                      amount={fmtMoney(b.balance)}
                      urgent={urgent}
                    />
                  );
                })}
                {dueSoon.length > 15 && (
                  <div className="text-xs text-ink-light italic pt-2">+ {dueSoon.length - 15} more</div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h3 className="font-bold text-navy mb-3">All outstanding bills by vendor</h3>
            <div className="space-y-2">
              {vendors.slice(0, 20).map((v, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                  <div className="text-sm">
                    <div className="font-semibold text-navy">{v.name}</div>
                    <div className="text-xs text-ink-slate">
                      {v.bills} bill{v.bills === 1 ? "" : "s"} · oldest {v.oldestDays}d
                    </div>
                  </div>
                  <div className="font-bold text-navy">{fmtMoney(v.total)}</div>
                </div>
              ))}
              {vendors.length > 20 && (
                <div className="text-xs text-ink-light italic pt-1">+ {vendors.length - 20} more vendors</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function BillRow({ payee, due, daysAway, amount, urgent }: { payee: string; due: string; daysAway: number; amount: string; urgent?: boolean }) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg ${urgent ? "bg-red-50 border border-red-200" : "bg-slate-50 border border-slate-100"}`}>
      <div className="flex items-center gap-3">
        <Calendar size={14} className={urgent ? "text-red-700" : "text-ink-slate"} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-navy">{payee}</span>
            {urgent && <span className="text-[9px] font-bold bg-red-100 text-red-800 px-1 rounded">URGENT</span>}
          </div>
          <div className="text-xs text-ink-slate">{due} · {daysAway} day{daysAway === 1 ? "" : "s"} away</div>
        </div>
      </div>
      <div className="text-lg font-bold text-navy">{amount}</div>
    </div>
  );
}
