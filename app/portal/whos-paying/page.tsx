import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import { ageInvoices } from "@/lib/portal-data";
import { PortalErrorState } from "../error-state";
import { AlertCircle, Clock } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * "Who owes you" — live A/R aging grouped by customer.
 *
 * Pulls all open invoices, ages them via the shared helper, then groups
 * by customer for the card list. Bookkeeper-side has more complex flows
 * (UF→A/R matcher, etc.); the portal view is read-only and
 * customer-summary-first.
 */
export default async function WhosPayingPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  let invoices: Awaited<ReturnType<typeof fetchOpenInvoices>> = [];
  try {
    invoices = await fetchOpenInvoices(ctx.qboRealmId, ctx.accessToken);
  } catch {
    /* fall through to empty state */
  }

  const aging = ageInvoices(invoices);

  // Group by customer
  const byCustomer = new Map<string, {
    name: string; total: number; oldestDays: number;
    invoices: { num: string; date: string; amount: number; daysOverdue: number }[];
  }>();
  const today = new Date();
  for (const inv of invoices) {
    const key = inv.customer_id || `__name:${inv.customer_name || "(no customer)"}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        name: inv.customer_name || "(no customer name)",
        total: 0, oldestDays: 0, invoices: [],
      });
    }
    const g = byCustomer.get(key)!;
    const dueDate = new Date(inv.due_date || inv.txn_date);
    const daysOverdue = Math.max(0, Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000));
    g.total += inv.balance;
    g.oldestDays = Math.max(g.oldestDays, daysOverdue);
    g.invoices.push({
      num: inv.doc_number || inv.qbo_invoice_id,
      date: inv.txn_date,
      amount: inv.balance,
      daysOverdue,
    });
  }
  const customers = Array.from(byCustomer.values()).sort((a, b) => {
    // Urgency first (highest oldest), then biggest amount
    if (b.oldestDays !== a.oldestDays) return b.oldestDays - a.oldestDays;
    return b.total - a.total;
  });

  const overdueTotal =
    aging.buckets["1-30"].total + aging.buckets["31-60"].total +
    aging.buckets["61-90"].total + aging.buckets["90+"].total;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Outstanding invoices</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Who owes you money</h1>
        <div className="text-sm text-ink-slate mt-1">
          {fmtMoney(aging.totalAmount)} across {byCustomer.size} customer{byCustomer.size === 1 ? "" : "s"}
        </div>
      </div>

      {overdueTotal > 0 && (
        <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
          <strong className="text-teal-dark">Heads up:</strong> {fmtMoney(overdueTotal)} of this is past
          due. Top customers to follow up with are at the top of the list.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Bucket label="Current" amount={fmtMoney(aging.buckets.current.total)} count={aging.buckets.current.count} color="emerald" />
        <Bucket label="1–30 days late" amount={fmtMoney(aging.buckets["1-30"].total)} count={aging.buckets["1-30"].count} color="amber" />
        <Bucket label="31–60 days" amount={fmtMoney(aging.buckets["31-60"].total)} count={aging.buckets["31-60"].count} color="orange" />
        <Bucket label="60+ days" amount={fmtMoney(aging.buckets["61-90"].total + aging.buckets["90+"].total)} count={aging.buckets["61-90"].count + aging.buckets["90+"].count} color="red" />
      </div>

      <div className="space-y-3">
        {customers.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-ink-slate">
            No open invoices — all customers are paid up.
          </div>
        ) : (
          customers.slice(0, 30).map((c, i) => (
            <CustomerCard key={i} {...c} />
          ))
        )}
        {customers.length > 30 && (
          <div className="text-center text-sm text-ink-slate py-3">
            + {customers.length - 30} more customers — ask your bookkeeper for a full export
          </div>
        )}
      </div>
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function Bucket({ label, amount, count, color }: { label: string; amount: string; count: number; color: string }) {
  const colors: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    orange: "bg-orange-50 border-orange-200 text-orange-900",
    red: "bg-red-50 border-red-200 text-red-900",
  };
  return (
    <div className={`p-3 rounded-xl border ${colors[color]}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-80">{label}</div>
      <div className="text-lg font-bold mt-1">{amount}</div>
      <div className="text-[11px] opacity-70">{count} invoice{count === 1 ? "" : "s"}</div>
    </div>
  );
}

function CustomerCard({
  name, total, oldestDays, invoices,
}: {
  name: string; total: number; oldestDays: number;
  invoices: { num: string; date: string; amount: number; daysOverdue: number }[];
}) {
  const urgent = oldestDays > 30;
  return (
    <div className={`bg-white border rounded-2xl p-5 ${urgent ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-navy">{name}</h3>
            {urgent && (
              <span className="text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                <AlertCircle size={9} className="inline mr-0.5" />
                URGENT
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-navy">{fmtMoney(total)}</div>
          <div className="text-xs text-ink-slate">
            <Clock size={10} className="inline mr-0.5" />
            Oldest: {oldestDays}d
          </div>
        </div>
      </div>
      <div className="space-y-1">
        {invoices.slice(0, 5).map((inv, i) => (
          <div key={i} className="flex items-center justify-between text-xs text-ink-slate">
            <span>{inv.num} · {inv.date}</span>
            <span className="font-mono">
              {fmtMoney(inv.amount)}
              {inv.daysOverdue > 0 && (
                <span className="text-red-700 font-semibold ml-2">({inv.daysOverdue}d late)</span>
              )}
            </span>
          </div>
        ))}
        {invoices.length > 5 && (
          <div className="text-[11px] text-ink-light italic">+ {invoices.length - 5} more invoices</div>
        )}
      </div>
    </div>
  );
}
