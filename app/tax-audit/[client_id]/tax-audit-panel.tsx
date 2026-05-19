"use client";

import { useState } from "react";
import {
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronRight,
  Loader2, Play, Info,
} from "lucide-react";

interface AuditResult {
  client: {
    name: string; province: string; provinceCode: string;
    taxRate: number; taxRateDisplay: string;
  };
  period: { startDate: string; endDate: string };
  pnl: {
    totalIncome: number; totalExpenses: number;
    netIncome: number; mealsExpense: number;
  };
  tests: {
    accountInventory: {
      accounts: { name: string; id: string; balance: number; type: string }[];
      netPayable: number; netReceivable: number;
      pass: boolean; message: string;
    };
    salesTaxTest: {
      totalRevenue: number; taxRate: number; taxRateDisplay: string;
      expectedCollected: number; netPayableBalance: number; variancePct: number;
      pass: boolean; message: string;
    };
    meals50Test: {
      mealsExpense: number;
      mealsAccounts: { label: string; amount: number }[];
      gstHstRate: number;
      estimatedGSTOnMeals: number;
      maxAllowableMealsITC: number;
      hasExpense: boolean;
      pass: boolean; message: string;
    };
  };
}

type PeriodPreset =
  | "this_month" | "last_month"
  | "q1" | "q2" | "q3" | "q4"
  | "this_year" | "last_year"
  | "custom";

function fmt(n: number) {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getPeriodDates(preset: PeriodPreset, customStart: string, customEnd: string): { start: string; end: string; label: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  if (preset === "custom") return { start: customStart, end: customEnd, label: `${customStart} – ${customEnd}` };

  const pad = (n: number) => String(n).padStart(2, "0");
  const date = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();

  switch (preset) {
    case "this_month": {
      const start = date(y, m + 1, 1);
      const end = date(y, m + 1, lastDay(y, m + 1));
      return { start, end, label: now.toLocaleString("en-CA", { month: "long", year: "numeric" }) };
    }
    case "last_month": {
      const lm = m === 0 ? 12 : m;
      const ly = m === 0 ? y - 1 : y;
      return { start: date(ly, lm, 1), end: date(ly, lm, lastDay(ly, lm)), label: new Date(ly, lm - 1).toLocaleString("en-CA", { month: "long", year: "numeric" }) };
    }
    case "q1": return { start: date(y, 1, 1), end: date(y, 3, 31), label: `Q1 ${y} (Jan–Mar)` };
    case "q2": return { start: date(y, 4, 1), end: date(y, 6, 30), label: `Q2 ${y} (Apr–Jun)` };
    case "q3": return { start: date(y, 7, 1), end: date(y, 9, 30), label: `Q3 ${y} (Jul–Sep)` };
    case "q4": return { start: date(y, 10, 1), end: date(y, 12, 31), label: `Q4 ${y} (Oct–Dec)` };
    case "this_year": return { start: date(y, 1, 1), end: date(y, 12, 31), label: `${y} (Full Year)` };
    case "last_year": return { start: date(y - 1, 1, 1), end: date(y - 1, 12, 31), label: `${y - 1} (Full Year)` };
  }
}

function StatusIcon({ pass, advisory }: { pass: boolean; advisory?: boolean }) {
  if (advisory) return <Info size={18} className="text-blue-500 flex-shrink-0" />;
  if (pass) return <CheckCircle2 size={18} className="text-green-600 flex-shrink-0" />;
  return <XCircle size={18} className="text-red-500 flex-shrink-0" />;
}

function TestCard({
  title, status, message, children,
}: {
  title: string;
  status: "pass" | "fail" | "advisory" | "empty";
  message: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const borderColor =
    status === "pass" ? "border-green-200" :
    status === "fail" ? "border-red-200" :
    status === "advisory" ? "border-blue-200" :
    "border-gray-200";
  const bgColor =
    status === "pass" ? "bg-green-50" :
    status === "fail" ? "bg-red-50" :
    status === "advisory" ? "bg-blue-50" :
    "bg-gray-50";
  const labelColor =
    status === "pass" ? "text-green-700" :
    status === "fail" ? "text-red-700" :
    status === "advisory" ? "text-blue-700" :
    "text-ink-slate";
  const statusLabel =
    status === "pass" ? "Pass" :
    status === "fail" ? "Review required" :
    status === "advisory" ? "Advisory" :
    "N/A";

  return (
    <div className={`rounded-xl border ${borderColor} overflow-hidden`}>
      <div className={`${bgColor} px-5 py-4`}>
        <div className="flex items-start gap-3">
          <StatusIcon
            pass={status === "pass"}
            advisory={status === "advisory"}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-bold text-navy">{title}</span>
              <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                status === "pass" ? "bg-green-100 text-green-700" :
                status === "fail" ? "bg-red-100 text-red-700" :
                status === "advisory" ? "bg-blue-100 text-blue-700" :
                "bg-gray-100 text-ink-slate"
              }`}>{statusLabel}</span>
            </div>
            <p className="text-sm text-ink-slate leading-relaxed">{message}</p>
          </div>
          {children && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex-shrink-0 text-ink-slate hover:text-navy transition-colors"
            >
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}
        </div>
      </div>
      {open && children && (
        <div className="bg-white px-5 py-4 border-t border-gray-100">{children}</div>
      )}
    </div>
  );
}

export function TaxAuditPanel({
  clientId,
  clientName,
  provinceCode,
  taxRateDisplay,
}: {
  clientId: string;
  clientName: string;
  provinceCode: string;
  taxRateDisplay: string;
}) {
  const [preset, setPreset] = useState<PeriodPreset>("q1");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState("");

  const presets: { key: PeriodPreset; label: string }[] = [
    { key: "this_month", label: "This Month" },
    { key: "last_month", label: "Last Month" },
    { key: "q1", label: "Q1 (Jan–Mar)" },
    { key: "q2", label: "Q2 (Apr–Jun)" },
    { key: "q3", label: "Q3 (Jul–Sep)" },
    { key: "q4", label: "Q4 (Oct–Dec)" },
    { key: "this_year", label: "This Year" },
    { key: "last_year", label: "Last Year" },
    { key: "custom", label: "Custom" },
  ];

  async function runAudit() {
    const { start, end } = getPeriodDates(preset, customStart, customEnd);
    if (!start || !end) {
      setError("Please select a valid period.");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch(
        `/api/tax-audit/${clientId}?start_date=${start}&end_date=${end}`
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Audit failed");
      }
      setResult(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h3 className="text-sm font-bold text-navy mb-4">Select audit period</h3>
        <div className="flex flex-wrap gap-2 mb-4">
          {presets.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPreset(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors border ${
                preset === key
                  ? "bg-teal text-white border-teal"
                  : "bg-white text-ink-slate border-gray-200 hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <div className="flex gap-3 mb-4">
            <div>
              <label className="block text-xs font-semibold text-ink-slate mb-1">Start date</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink-slate mb-1">End date</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        {preset !== "custom" && (
          <p className="text-xs text-ink-slate mb-4">
            Period:{" "}
            <span className="font-semibold text-navy">
              {(() => { const { start, end, label } = getPeriodDates(preset, customStart, customEnd); return `${label} (${start} → ${end})`; })()}
            </span>
          </p>
        )}

        <button
          onClick={runAudit}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal text-white text-sm font-bold hover:bg-teal-dark transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {loading ? "Running audit…" : "Run GST/HST Audit"}
        </button>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
            {error}
          </div>
        )}
      </div>

      {/* Results */}
      {result && (
        <>
          {/* P&L summary banner */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className="text-xs font-bold uppercase tracking-wide text-ink-slate mb-3">
              P&L Summary — {result.client.province} ({result.client.taxRateDisplay})
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Total Revenue", value: result.pnl.totalIncome, highlight: true },
                { label: "Total Expenses", value: result.pnl.totalExpenses },
                { label: "Net Income", value: result.pnl.netIncome },
                { label: "Meals & Entertainment", value: result.pnl.mealsExpense },
              ].map(({ label, value, highlight }) => (
                <div key={label} className="rounded-lg bg-gray-50 px-4 py-3">
                  <div className="text-xs text-ink-slate mb-1">{label}</div>
                  <div className={`text-lg font-bold ${highlight ? "text-teal" : "text-navy"}`}>
                    ${fmt(value)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Test 1 */}
          <TestCard
            title="Test 1 — GST/HST Account Inventory"
            status={result.tests.accountInventory.pass ? "pass" : "fail"}
            message={result.tests.accountInventory.message}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-bold uppercase text-ink-slate border-b border-gray-100">
                  <th className="text-left pb-2">Account</th>
                  <th className="text-left pb-2">Type</th>
                  <th className="text-right pb-2">Current Balance</th>
                </tr>
              </thead>
              <tbody>
                {result.tests.accountInventory.accounts.map((a) => (
                  <tr key={a.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-2 font-medium text-navy">{a.name}</td>
                    <td className="py-2 capitalize text-ink-slate">{a.type}</td>
                    <td className={`py-2 text-right font-semibold ${
                      a.balance > 0 ? "text-red-600" : a.balance < 0 ? "text-green-700" : "text-ink-slate"
                    }`}>
                      {a.balance < 0 && "-"}${fmt(Math.abs(a.balance))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 text-sm font-bold">
                <tr>
                  <td colSpan={2} className="pt-2 text-navy">Net payable to CRA</td>
                  <td className={`pt-2 text-right ${result.tests.accountInventory.netPayable > 0 ? "text-red-700" : "text-green-700"}`}>
                    {result.tests.accountInventory.netPayable < 0 && "-"}${fmt(Math.abs(result.tests.accountInventory.netPayable))}
                  </td>
                </tr>
              </tfoot>
            </table>
            <p className="text-xs text-ink-light mt-3">
              Balance reflects current date in QBO, not period-end. For an exact period-end balance, check the QBO Balance Sheet.
            </p>
          </TestCard>

          {/* Test 2 */}
          <TestCard
            title="Test 2 — Sales Tax Collected vs. Revenue"
            status={result.tests.salesTaxTest.pass ? "pass" : "fail"}
            message={result.tests.salesTaxTest.message}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Total Revenue", value: `$${fmt(result.tests.salesTaxTest.totalRevenue)}` },
                  {
                    label: `Expected GST/HST (${(result.tests.salesTaxTest.taxRate * 100).toFixed(0)}%)`,
                    value: `$${fmt(result.tests.salesTaxTest.expectedCollected)}`,
                  },
                  {
                    label: "Actual Net Payable",
                    value: `$${fmt(result.tests.salesTaxTest.netPayableBalance)}`,
                    highlight: !result.tests.salesTaxTest.pass,
                  },
                ].map(({ label, value, highlight }) => (
                  <div key={label} className="rounded-lg bg-gray-50 px-4 py-3">
                    <div className="text-xs text-ink-slate mb-1">{label}</div>
                    <div className={`text-base font-bold ${highlight ? "text-red-600" : "text-navy"}`}>{value}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-100">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">
                  The expected amount assumes 100% of revenue is taxable. Zero-rated supplies (e.g., basic groceries, certain residential rents) would reduce the expected amount. Adjust accordingly if the client has zero-rated revenue.
                </p>
              </div>
            </div>
          </TestCard>

          {/* Test 3 */}
          <TestCard
            title="Test 3 — Meals & Entertainment 50% ITC Rule"
            status={result.tests.meals50Test.hasExpense ? "advisory" : "empty"}
            message={result.tests.meals50Test.message}
          >
            {result.tests.meals50Test.hasExpense && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Meals Expense (net)", value: `$${fmt(result.tests.meals50Test.mealsExpense)}` },
                    {
                      label: `Est. GST/HST on Meals (${(result.tests.meals50Test.gstHstRate * 100).toFixed(0)}%)`,
                      value: `$${fmt(result.tests.meals50Test.estimatedGSTOnMeals)}`,
                    },
                    {
                      label: "Max Allowable ITC (50%)",
                      value: `$${fmt(result.tests.meals50Test.maxAllowableMealsITC)}`,
                      highlight: true,
                    },
                  ].map(({ label, value, highlight }) => (
                    <div key={label} className="rounded-lg bg-gray-50 px-4 py-3">
                      <div className="text-xs text-ink-slate mb-1">{label}</div>
                      <div className={`text-base font-bold ${highlight ? "text-teal" : "text-navy"}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {result.tests.meals50Test.mealsAccounts.length > 1 && (
                  <div>
                    <div className="text-xs font-bold text-ink-slate mb-2">Meals accounts found:</div>
                    <div className="space-y-1">
                      {result.tests.meals50Test.mealsAccounts.map((a, i) => (
                        <div key={i} className="flex justify-between text-sm px-3 py-1.5 rounded bg-gray-50">
                          <span className="text-navy">{a.label}</span>
                          <span className="font-semibold text-ink-slate">${fmt(Math.abs(a.amount))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="p-3 rounded-lg bg-blue-50 border border-blue-100">
                  <p className="text-xs text-blue-800 leading-relaxed">
                    <strong>How to verify:</strong> In QBO, run a Transaction Detail report for the meals account.
                    For each transaction, the ITC claimed should be ≤ 50% of the GST/HST on that transaction.
                    If QBO auto-applied the full ITC on meals, you'll need to create a manual journal entry to
                    record the non-deductible 50% portion as an additional expense.
                  </p>
                </div>
              </div>
            )}
          </TestCard>
        </>
      )}
    </div>
  );
}
