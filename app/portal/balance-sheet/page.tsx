import { tryResolvePortalContext } from "@/lib/portal-context";
import { fetchBalanceSheetSummary } from "@/lib/portal-data";
import { PortalErrorState } from "../error-state";
import { HelpCircle } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Live Balance Sheet, simplified "own / owe / yours" framing.
 *
 * Strategy: pull the BS report at "today" + the accounts list, then bucket
 * accounts by Classification (Asset / Liability / Equity) and show the
 * largest items in each. No drill-in on individual transactions yet —
 * that's a future enhancement once we know clients want it.
 */
export default async function BalanceSheetPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const bs = await fetchBalanceSheetSummary(ctx.qboRealmId, ctx.accessToken);

  // Group by classification, sort by abs(balance) desc, top N per group.
  const groups = {
    Asset: [] as { name: string; balance: number }[],
    Liability: [] as { name: string; balance: number }[],
    Equity: [] as { name: string; balance: number }[],
  };
  for (const acct of bs.accounts) {
    const bal = bs.balances.get(acct.Id) ?? 0;
    if (Math.abs(bal) < 0.01) continue;
    const g = acct.Classification as keyof typeof groups;
    if (g in groups) {
      groups[g].push({ name: acct.Name, balance: bal });
    }
  }
  for (const k of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  const netWorth = bs.totalAssets - bs.totalLiabilities;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Balance Sheet</div>
        <h1 className="text-3xl font-bold text-navy mt-1">What you own & what you owe</h1>
        <div className="text-sm text-ink-slate mt-1">
          As of {formatDate(bs.asOfDate)} · Snapshot in time
        </div>
      </div>

      <div className="bg-teal/5 border border-teal/30 rounded-xl p-4 text-sm text-navy/80 leading-relaxed">
        <strong className="text-teal-dark">In plain English:</strong> If you sold everything today
        and paid off every debt, you'd have about{" "}
        <strong>{fmtMoney(netWorth)}</strong> left over. That's your "net worth" as a business —
        the value built up from past profits, owner investments, and equity in your assets.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card
          title="What you own"
          subtitle='"Assets"'
          amount={fmtMoney(bs.totalAssets)}
          tone="emerald"
          rows={groups.Asset}
        />
        <Card
          title="What you owe"
          subtitle='"Liabilities"'
          amount={fmtMoney(bs.totalLiabilities)}
          tone="amber"
          rows={groups.Liability}
        />
        <Card
          title="What's yours"
          subtitle='"Equity" — own minus owe'
          amount={fmtMoney(netWorth)}
          tone="teal"
          rows={groups.Equity}
          emphasize
        />
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center text-sm text-ink-slate">
        <strong className="text-navy">{fmtMoney(bs.totalAssets)}</strong> (you own) −{" "}
        <strong className="text-navy">{fmtMoney(bs.totalLiabilities)}</strong> (you owe) ={" "}
        <strong className="text-teal-dark">{fmtMoney(netWorth)}</strong> (yours) ✓
        <div className="text-xs text-ink-light mt-1">
          That's why it's called a "balance" sheet — these always equal out.
        </div>
      </div>
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
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function Card({
  title, subtitle, amount, tone, rows, emphasize,
}: {
  title: string; subtitle: string; amount: string;
  tone: "emerald" | "amber" | "teal";
  rows: { name: string; balance: number }[];
  emphasize?: boolean;
}) {
  const toneColors = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    teal: "text-teal-dark",
  }[tone];
  const borderClass = emphasize ? "border-2 border-teal/40" : "border border-slate-200";
  return (
    <div className={`bg-white ${borderClass} rounded-2xl p-5`}>
      <div className={`text-xs ${emphasize ? "text-teal-dark" : "text-ink-slate"} uppercase tracking-wider font-semibold mb-1`}>
        {title}
      </div>
      <div className={`text-2xl font-bold ${toneColors}`}>{amount}</div>
      <div className="text-xs text-ink-slate mt-1">{subtitle}</div>
      <div className="mt-4 space-y-2 text-sm">
        {rows.length === 0 ? (
          <div className="text-xs text-ink-light italic">No items.</div>
        ) : (
          rows.slice(0, 8).map((r, i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="text-ink-slate truncate" title={r.name}>{r.name}</span>
              <span className="font-mono text-sm text-navy ml-2 flex-shrink-0">{fmtMoney(r.balance)}</span>
            </div>
          ))
        )}
        {rows.length > 8 && (
          <div className="text-[11px] text-ink-light italic">+ {rows.length - 8} smaller items</div>
        )}
      </div>
    </div>
  );
}
