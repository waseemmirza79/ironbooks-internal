"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Banknote,
} from "lucide-react";

type Finding = {
  client_link_id: string;
  client_name: string;
  current_mode: string;
  window?: { start: string; end: string };
  flagged: boolean;
  reason: string;
  invoice_txn_count: number;
  invoice_income_total: number;
  invoice_by_account?: Record<string, number>;
  deposit_count: number;
  deposit_income_total: number;
  pair_count: number;
  paired_invoice_total: number;
  paired_deposit_total: number;
  found_at: string;
};

type Pair = {
  invoice: { txn_id: string; doc_number: string | null; customer: string | null; date: string; total: number; accounts: string[] };
  deposit: { txn_id: string; date: string; account: string; customer: string | null; amount: number };
  factor: number;
  tax_label: string;
  same_customer: boolean;
  confidence: string;
  invoice_balance: number | null;
  scenario: "paid_in_qbo" | "open" | "unknown";
};

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();
const fmtC = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CrmInvoiceRevenueClient({
  findings,
  lastCompletedAt,
  lastWindow,
}: {
  findings: Finding[];
  lastCompletedAt: string | null;
  lastWindow: { start: string; end: string } | null;
}) {
  const router = useRouter();
  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pairs, setPairs] = useState<Record<string, { loading: boolean; error?: string; data?: any }>>({});
  const [modeBusy, setModeBusy] = useState<string | null>(null);
  const [modeLocal, setModeLocal] = useState<Record<string, string>>({});

  const flagged = findings.filter((f) => f.flagged);

  // Drive the sweep chunk-by-chunk from the browser. The server also
  // self-chains when CRON_SECRET is set — the loop stops as soon as the
  // response says so (double-firing a chunk is harmless, newest finding wins).
  async function runSweep() {
    if (
      !confirm(
        "Scan every production client for CRM invoices double-counting deposit revenue?\n\n" +
          "Read-only against QuickBooks. Takes a few minutes fleet-wide; findings appear as chunks finish."
      )
    )
      return;
    setSweeping(true);
    setSweepMsg("Starting…");
    try {
      let offset: number | null = 0;
      for (let i = 0; i < 60 && offset !== null; i++) {
        const res: Response = await fetch(`/api/admin/crm-invoice-sweep?offset=${offset}`, { method: "POST" });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.server_chained) {
          setSweepMsg(`Sweeping ${j.targets} clients in the background — refresh in a few minutes.`);
          offset = null;
        } else {
          offset = j.next_offset;
          setSweepMsg(
            offset === null
              ? `Done — ${j.targets} clients scanned.`
              : `${Math.min(offset, j.targets)} of ${j.targets} scanned…`
          );
        }
      }
      setTimeout(() => router.refresh(), 1500);
    } catch (e: any) {
      setSweepMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setSweeping(false);
    }
  }

  async function loadPairs(f: Finding) {
    setPairs((p) => ({ ...p, [f.client_link_id]: { loading: true } }));
    try {
      const res = await fetch("/api/admin/crm-invoice-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: f.client_link_id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setPairs((p) => ({ ...p, [f.client_link_id]: { loading: false, data: j } }));
    } catch (e: any) {
      setPairs((p) => ({ ...p, [f.client_link_id]: { loading: false, error: e?.message || "failed" } }));
    }
  }

  async function setMode(f: Finding, mode: "standard" | "deposits_only") {
    const label = mode === "deposits_only" ? "CASH-DEPOSITS-ONLY" : "STANDARD";
    if (
      !confirm(
        `Set ${f.client_name} to ${label} revenue recognition?\n\n` +
          (mode === "deposits_only"
            ? "Their statements will recognize actual cash deposits only — CRM invoice income is excluded. Reversible."
            : "Their statements go back to standard QBO cash-basis income (invoices count again).")
      )
    )
      return;
    setModeBusy(f.client_link_id);
    try {
      const res = await fetch("/api/admin/revenue-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: f.client_link_id, mode }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setModeLocal((m) => ({ ...m, [f.client_link_id]: mode }));
    } catch (e: any) {
      alert(`Mode change failed: ${e?.message || "unknown"}`);
    } finally {
      setModeBusy(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="grid grid-cols-3 gap-4 flex-1 mr-4">
          <Stat label="Clients with CRM invoices" value={String(findings.length)} />
          <Stat label="Flagged (double-count evidence)" value={String(flagged.length)} accent={flagged.length > 0} />
          <Stat
            label="Paired deposit revenue (dupes)"
            value={fmt(flagged.reduce((s, f) => s + (f.paired_deposit_total || 0), 0))}
          />
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={runSweep}
            disabled={sweeping}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal text-white px-3 py-2 text-sm font-semibold hover:bg-teal/90 disabled:opacity-50"
          >
            {sweeping ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Run sweep
          </button>
          {sweepMsg && <span className="text-[11px] text-ink-slate">{sweepMsg}</span>}
          {lastCompletedAt && !sweepMsg && (
            <span className="text-[11px] text-ink-light">
              Last sweep {new Date(lastCompletedAt).toLocaleString()}
              {lastWindow ? ` · ${lastWindow.start} → ${lastWindow.end}` : ""}
            </span>
          )}
        </div>
      </div>

      {findings.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-ink-light">
          No findings yet. Run the sweep — clients with CRM-pushed invoices land here as each chunk finishes.
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-[11px] uppercase tracking-wide text-ink-slate">
                <th className="text-left font-semibold px-4 py-2.5">Client</th>
                <th className="text-right font-semibold px-3 py-2.5">Invoice income</th>
                <th className="text-right font-semibold px-3 py-2.5">Deposits in income</th>
                <th className="text-right font-semibold px-3 py-2.5">Matched pairs</th>
                <th className="text-left font-semibold px-3 py-2.5">Revenue mode</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {findings.map((f) => {
                const isOpen = !!open[f.client_link_id];
                const mode = modeLocal[f.client_link_id] || f.current_mode;
                const pr = pairs[f.client_link_id];
                return (
                  <FragmentRow
                    key={f.client_link_id}
                    f={f}
                    isOpen={isOpen}
                    mode={mode}
                    pr={pr}
                    modeBusy={modeBusy === f.client_link_id}
                    onToggle={() => {
                      setOpen((o) => ({ ...o, [f.client_link_id]: !isOpen }));
                      if (!isOpen && !pr) loadPairs(f);
                    }}
                    onSetMode={(m) => setMode(f, m)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  f,
  isOpen,
  mode,
  pr,
  modeBusy,
  onToggle,
  onSetMode,
}: {
  f: Finding;
  isOpen: boolean;
  mode: string;
  pr?: { loading: boolean; error?: string; data?: any };
  modeBusy: boolean;
  onToggle: () => void;
  onSetMode: (m: "standard" | "deposits_only") => void;
}) {
  const depositsOnly = mode === "deposits_only";
  return (
    <>
      <tr className={f.flagged ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-gray-50"}>
        <td className="px-4 py-2.5">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-left font-semibold text-navy hover:text-teal">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {f.client_name}
            {f.flagged && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5">
                <AlertTriangle size={9} /> flagged
              </span>
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-navy">{fmt(f.invoice_income_total)}</td>
        <td className="px-3 py-2.5 text-right font-mono text-navy">{fmt(f.deposit_income_total)}</td>
        <td className="px-3 py-2.5 text-right">
          {f.pair_count > 0 ? (
            <span className="font-mono text-red-700 font-semibold">{f.pair_count} · {fmt(f.paired_deposit_total)}</span>
          ) : (
            <span className="text-ink-light">—</span>
          )}
        </td>
        <td className="px-3 py-2.5">
          <span
            className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border whitespace-nowrap ${
              depositsOnly
                ? "bg-teal-lighter/60 text-teal-dark border-teal/30"
                : "bg-gray-100 text-gray-600 border-gray-200"
            }`}
          >
            {depositsOnly ? "deposits only" : "standard"}
          </span>
        </td>
        <td className="px-3 py-2.5 text-right">
          <button
            onClick={() => onSetMode(depositsOnly ? "standard" : "deposits_only")}
            disabled={modeBusy}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold border disabled:opacity-50 ${
              depositsOnly
                ? "border-gray-200 text-ink-slate hover:bg-gray-50"
                : "border-teal/40 bg-teal text-white hover:bg-teal/90"
            }`}
          >
            {modeBusy ? <Loader2 size={12} className="animate-spin" /> : <Banknote size={12} />}
            {depositsOnly ? "Revert to standard" : "Set deposits-only"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className="px-4 pb-4 pt-1 bg-gray-50/60">
            <div className="text-xs text-ink-slate mb-2">{f.reason}</div>
            {pr?.loading && (
              <div className="flex items-center gap-2 text-xs text-ink-slate py-3">
                <Loader2 size={13} className="animate-spin" /> Pulling live pairs from QuickBooks…
              </div>
            )}
            {pr?.error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{pr.error}</div>
            )}
            {pr?.data && <PairsTable data={pr.data} />}
          </td>
        </tr>
      )}
    </>
  );
}

function PairsTable({ data }: { data: any }) {
  const pairs: Pair[] = data.pairs || [];
  const sc = data.summary?.scenario_counts || {};
  if (pairs.length === 0) {
    return <div className="text-xs text-ink-light py-2">No deposit↔invoice pairs in the live pull.</div>;
  }
  return (
    <div>
      <div className="flex items-center gap-3 text-[11px] text-ink-slate mb-2">
        <span className="font-bold text-navy">{pairs.length} pairs</span>
        {sc.paid_in_qbo ? <span>{sc.paid_in_qbo} paid-in-QBO (deposit is the dupe leg)</span> : null}
        {sc.open ? <span>{sc.open} open (deposit never applied)</span> : null}
        {sc.unknown ? <span>{sc.unknown} unknown</span> : null}
      </div>
      <div className="border border-gray-200 rounded-lg overflow-x-auto bg-white">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr className="text-[10px] uppercase tracking-wide text-ink-slate">
              <th className="text-left font-semibold px-3 py-2">Customer</th>
              <th className="text-left font-semibold px-3 py-2">Invoice</th>
              <th className="text-right font-semibold px-3 py-2">Invoice net</th>
              <th className="text-left font-semibold px-3 py-2">Deposit → account</th>
              <th className="text-right font-semibold px-3 py-2">Deposit</th>
              <th className="text-left font-semibold px-3 py-2">Match</th>
              <th className="text-left font-semibold px-3 py-2">Scenario</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pairs.map((p, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-3 py-2 text-navy font-medium">{p.invoice.customer || p.deposit.customer || "—"}</td>
                <td className="px-3 py-2 text-ink-slate whitespace-nowrap">
                  {p.invoice.doc_number ? `#${p.invoice.doc_number}` : p.invoice.txn_id} · {p.invoice.date}
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtC(p.invoice.total)}</td>
                <td className="px-3 py-2 text-ink-slate">{p.deposit.account} · {p.deposit.date}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtC(p.deposit.amount)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="text-teal-dark font-semibold">{p.tax_label}</span>
                  {p.same_customer && <CheckCircle2 size={11} className="inline ml-1 text-emerald-600" />}
                  <span className="text-ink-light ml-1">({p.confidence})</span>
                </td>
                <td className="px-3 py-2">
                  {p.scenario === "paid_in_qbo" ? (
                    <span className="text-red-700 font-semibold">deposit is the dupe (invoice paid)</span>
                  ) : p.scenario === "open" ? (
                    <span className="text-amber-700 font-semibold">invoice open — never applied</span>
                  ) : (
                    <span className="text-ink-light">unknown</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${accent ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
      <div className={`text-lg font-bold ${accent ? "text-amber-800" : "text-navy"}`}>{value}</div>
      <div className="text-[11px] text-ink-slate">{label}</div>
    </div>
  );
}
