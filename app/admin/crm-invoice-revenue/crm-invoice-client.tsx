"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Loader2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, Banknote, CalendarRange, ExternalLink, CheckCircle2,
} from "lucide-react";
import { CrmPairsTable } from "@/components/crm-pairs-table";
import { QboRemediationPanel } from "@/components/QboRemediationPanel";

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

const fmt = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n || 0)).toLocaleString();

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

  // Remediation date range — shared by every client's Fix-in-QuickBooks panel
  // so Lisa sets the window once (default the full cleanup horizon so old
  // duplicate invoices are caught, not just this year).
  const now = new Date();
  const yr = now.getUTCFullYear();
  const RANGES: { key: string; label: string; start: string; end: string }[] = [
    { key: "ytd", label: "This year", start: `${yr}-01-01`, end: now.toISOString().slice(0, 10) },
    { key: "2y", label: `Since Jan ${yr - 1}`, start: `${yr - 1}-01-01`, end: now.toISOString().slice(0, 10) },
    { key: "all", label: `All history (since ${yr - 5})`, start: `${yr - 5}-01-01`, end: now.toISOString().slice(0, 10) },
  ];
  const [rangeKey, setRangeKey] = useState("2y");
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[1];

  // "Done" tracker so Lisa can work the list top-to-bottom and see progress.
  // Persisted per-browser so a refresh mid-fleet doesn't lose her place.
  const [done, setDone] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(window.localStorage.getItem("snap.crmRemediation.done") || "[]"));
    } catch {
      return new Set();
    }
  });
  function toggleDone(id: string) {
    setDone((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        window.localStorage.setItem("snap.crmRemediation.done", JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  }

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

      {flagged.length > 0 && (
        <div className="rounded-xl border border-teal/30 bg-teal-lighter/30 p-4 mb-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-navy">
              <div className="font-bold mb-0.5">Client-by-client cleanup</div>
              <ol className="text-xs text-ink-slate list-decimal ml-4 space-y-0.5">
                <li>Open a flagged client → <strong>Set deposits-only</strong> (fixes the statements immediately).</li>
                <li><strong>Load QuickBooks fix</strong> → <strong>Dry run</strong> → <strong>Void</strong> the duplicate invoices (deposits are never touched).</li>
                <li>Tick <strong>Done</strong> and move to the next. Your progress is saved on this browser.</li>
              </ol>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-teal-dark">
                {flagged.filter((f) => done.has(f.client_link_id)).length}/{flagged.length}
              </div>
              <div className="text-[11px] text-ink-slate">clients done</div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-teal/20">
            <CalendarRange size={13} className="text-teal shrink-0" />
            <span className="text-[11px] font-bold uppercase tracking-wide text-ink-slate">Void range</span>
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRangeKey(r.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  rangeKey === r.key ? "bg-teal text-white border-teal" : "bg-white text-ink-slate border-gray-200 hover:border-teal/50"
                }`}
              >
                {r.label}
              </button>
            ))}
            <span className="text-[11px] text-ink-light ml-auto">applies to the Fix-in-QuickBooks panel for every client</span>
          </div>
        </div>
      )}

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
                    range={range}
                    isDone={done.has(f.client_link_id)}
                    onToggleDone={() => toggleDone(f.client_link_id)}
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
  range,
  isDone,
  onToggleDone,
  onToggle,
  onSetMode,
}: {
  f: Finding;
  isOpen: boolean;
  mode: string;
  pr?: { loading: boolean; error?: string; data?: any };
  modeBusy: boolean;
  range: { start: string; end: string };
  isDone: boolean;
  onToggleDone: () => void;
  onToggle: () => void;
  onSetMode: (m: "standard" | "deposits_only") => void;
}) {
  const depositsOnly = mode === "deposits_only";
  return (
    <>
      <tr className={isDone ? "bg-emerald-50/50 hover:bg-emerald-50" : f.flagged ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-gray-50"}>
        <td className="px-4 py-2.5">
          <button onClick={onToggle} className="flex items-center gap-1.5 text-left font-semibold text-navy hover:text-teal">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {isDone && <CheckCircle2 size={14} className="text-emerald-600 shrink-0" />}
            <span className={isDone ? "line-through text-ink-slate" : ""}>{f.client_name}</span>
            {f.flagged && !isDone && (
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
            {pr?.data && <CrmPairsTable data={pr.data} />}

            {/* The QBO ledger fix — void the duplicate invoices for THIS client.
                Uses the range Lisa picked at the top. */}
            <div className="mt-3">
              <QboRemediationPanel
                clientLinkId={f.client_link_id}
                clientName={f.client_name}
                start={range.start}
                end={range.end}
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
              <Link
                href={`/revenue-check/${f.client_link_id}`}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:underline"
              >
                <ExternalLink size={12} /> Open full Revenue Check (custom range, statements)
              </Link>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-navy cursor-pointer">
                <input type="checkbox" checked={isDone} onChange={onToggleDone} className="accent-emerald-600" />
                <CheckCircle2 size={13} className={isDone ? "text-emerald-600" : "text-gray-300"} />
                Mark this client done
              </label>
            </div>
          </td>
        </tr>
      )}
    </>
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
