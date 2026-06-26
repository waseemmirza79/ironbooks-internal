"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, X } from "lucide-react";

type Cell = { collected: number; failed: number; manual: number };
type Row = {
  clientLinkId: string;
  company: string;
  contact: string;
  email: string | null;
  mrrCents: number;
  subStatus: string;
  matchMethod: string | null;
  stripeCustomerId: string | null;
  months: Record<number, Cell>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function BillingTable({ year, rows }: { year: number; rows: Row[] }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [modal, setModal] = useState<{ row: Row; month: number } | null>(null);
  const [matchRow, setMatchRow] = useState<Row | null>(null);

  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;

  async function sync() {
    setSyncing(true); setSyncMsg(null);
    try {
      const res = await fetch("/api/admin/billing/sync", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year }),
      });
      const j = await res.json();
      if (!res.ok) { setSyncMsg(j.error || "Sync failed"); return; }
      setSyncMsg(`Matched ${j.matched}/${j.scanned} clients · ${j.paymentsWritten} payments · ${j.unmatched?.length || 0} unmatched`);
      router.refresh();
    } catch (e: any) { setSyncMsg(e?.message || "Network error"); }
    finally { setSyncing(false); }
  }

  // Cell color per the spec: grey expected, green collected, red failed/missed,
  // dark green when more than MRR came in (setup fee / coaching call / extra).
  function cellStyle(row: Row, m: number): { bg: string; fg: string; label: string } {
    const c = row.months[m];
    const mrr = row.mrrCents;
    const isPast = year < curYear || (year === curYear && m < curMonth);
    const collected = c.collected;
    if (collected > 0) {
      if (mrr > 0 && collected > mrr + 50) return { bg: "#0F5132", fg: "#fff", label: money(collected) };   // dark green: extra
      return { bg: "#D1E7DD", fg: "#0F5132", label: money(collected) };                                      // green: collected
    }
    if (c.failed > 0) return { bg: "#F8D7DA", fg: "#842029", label: money(c.failed) };                        // red: failed
    if (isPast && mrr > 0 && ["active", "past_due"].includes(row.subStatus)) {
      return { bg: "#F8D7DA", fg: "#842029", label: "missed" };                                              // red: missed
    }
    return { bg: "#F1F3F5", fg: "#9AA3AD", label: mrr > 0 ? money(mrr) : "" };                                // grey: expected
  }

  const totalMrr = rows.reduce((s, r) => s + r.mrrCents, 0);
  const totalCollected = rows.reduce((s, r) => s + Object.values(r.months).reduce((a, c) => a + c.collected, 0), 0);

  return (
    <div className="px-4 py-6 max-w-[1700px] mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">Billing</h1>
          <p className="text-sm text-ink-slate mt-0.5">
            {rows.length} clients · MRR <strong>{money(totalMrr)}</strong> · collected {year}: <strong>{money(totalCollected)}</strong>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/admin/billing?year=${year - 1}`} className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm">←</a>
          <span className="text-sm font-bold text-navy">{year}</span>
          <a href={`/admin/billing?year=${year + 1}`} className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm">→</a>
          <button onClick={sync} disabled={syncing} className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3 py-2 rounded-lg disabled:opacity-60">
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync from Stripe
          </button>
        </div>
      </div>
      {syncMsg && <div className="mb-3 text-xs text-ink-slate bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">{syncMsg}</div>}

      <div className="flex flex-wrap gap-3 mb-3 text-[11px] text-ink-slate">
        <Legend bg="#D1E7DD" t="collected (= MRR)" /><Legend bg="#0F5132" t="extra (setup/coaching)" />
        <Legend bg="#F8D7DA" t="failed / missed" /><Legend bg="#F1F3F5" t="expected" />
        <span className="text-ink-light">· click any cell to log a manual (e-transfer) payment</span>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-xl">
        <table className="text-sm border-collapse w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 bg-gray-50 text-left font-semibold text-navy px-3 py-2 border-b border-gray-200 min-w-[180px]">Company</th>
              <th className="text-left font-semibold text-navy px-3 py-2 border-b border-gray-200 min-w-[140px]">Contact</th>
              <th className="text-right font-semibold text-navy px-3 py-2 border-b border-gray-200">MRR</th>
              {MONTHS.map((mm) => <th key={mm} className="text-center font-semibold text-ink-slate px-2 py-2 border-b border-gray-200">{mm}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.clientLinkId} className="hover:bg-gray-50/50">
                <td className="sticky left-0 bg-white px-3 py-1.5 border-b border-gray-100 max-w-[240px]">
                  <div className="font-medium text-navy truncate" title={r.company}>{r.company}</div>
                  <button
                    onClick={() => setMatchRow(r)}
                    className="text-[11px] text-teal-dark hover:underline truncate max-w-[220px] block"
                    title="Click to match a Stripe customer"
                  >
                    {r.stripeCustomerId
                      ? <span className="text-emerald-600">✓ Stripe matched{r.matchMethod ? ` (${r.matchMethod})` : ""} — change</span>
                      : (r.email || "no email — match Stripe")}
                  </button>
                </td>
                <td className="px-3 py-1.5 border-b border-gray-100 text-ink-slate truncate max-w-[160px]">{r.contact}</td>
                <td className="px-3 py-1.5 border-b border-gray-100 text-right text-navy font-semibold">{r.mrrCents > 0 ? money(r.mrrCents) : "—"}</td>
                {MONTHS.map((_, i) => {
                  const m = i + 1;
                  const st = cellStyle(r, m);
                  return (
                    <td key={m} className="border-b border-l border-gray-100 p-0">
                      <button onClick={() => setModal({ row: r, month: m })} title="Log manual payment"
                        className="w-full h-full px-1 py-1.5 text-center text-[11px] font-medium hover:opacity-80"
                        style={{ background: st.bg, color: st.fg }}>
                        {st.label || " "}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && <ManualModal row={modal.row} month={modal.month} year={year} onClose={() => setModal(null)} onSaved={() => { setModal(null); router.refresh(); }} />}
      {matchRow && <StripeMatchModal row={matchRow} year={year} onClose={() => setMatchRow(null)} onSaved={() => { setMatchRow(null); router.refresh(); }} />}
    </div>
  );
}

function StripeMatchModal({ row, year, onClose, onSaved }: { row: Row; year: number; onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<{ id: string; name: string | null; email: string | null; matched_on: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/admin/billing/stripe-candidates?client_link_id=${row.clientLinkId}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setErr(j.error); else setCandidates(j.candidates || []); })
      .catch((e) => setErr(e?.message || "Couldn't load candidates"))
      .finally(() => setLoading(false));
  }, [row.clientLinkId]);

  async function assign(stripeCustomerId: string) {
    setAssigning(stripeCustomerId); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: row.clientLinkId, stripe_customer_id: stripeCustomerId, year }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Match failed"); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setAssigning(null); }
  }

  return (
    <div style={{ minHeight: "100vh" }} className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-navy">Match Stripe customer</h3>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">{row.company}{row.email ? ` · ${row.email}` : ""}</p>
        {loading && <div className="flex items-center gap-2 text-sm text-ink-light py-4"><Loader2 size={14} className="animate-spin" /> Searching Stripe…</div>}
        {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">{err}</div>}
        {!loading && candidates.length === 0 && !err && (
          <p className="text-sm text-ink-slate py-2">No close Stripe customers found by email or name. Try the Sync, or this client may pay off-Stripe (use a manual payment on a cell).</p>
        )}
        <ul className="space-y-2 max-h-[50vh] overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-navy truncate">{c.name || "(no name)"}</div>
                <div className="text-xs text-ink-slate truncate">{c.email || "(no email)"} · matched on {c.matched_on}</div>
              </div>
              <button
                onClick={() => assign(c.id)}
                disabled={!!assigning}
                className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-60 flex-shrink-0"
              >
                {assigning === c.id ? <Loader2 size={12} className="animate-spin" /> : null} Match
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Legend({ bg, t }: { bg: string; t: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded" style={{ background: bg }} />{t}</span>;
}

function ManualModal({ row, month, year, onClose, onSaved }: { row: Row; month: number; year: number; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState((row.mrrCents / 100 || 0).toString());
  const [method, setMethod] = useState("etransfer");
  const [kind, setKind] = useState("subscription");
  const [status, setStatus] = useState("collected");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/admin/billing/payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: row.clientLinkId, year, month, amount: Number(amount), method, kind, status, note }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Save failed"); return; }
      onSaved();
    } catch (e: any) { setErr(e?.message || "Network error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ minHeight: "100vh" }} className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-navy">Log payment</h3>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy"><X size={16} /></button>
        </div>
        <p className="text-xs text-ink-slate mb-3">{row.company} · {MONTHS[month - 1]} {year}</p>
        <div className="space-y-2.5">
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Amount ($)</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" /></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="etransfer">E-transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="subscription">Subscription</option><option value="setup_fee">Setup fee</option><option value="coaching_call">Coaching call</option><option value="other">Other</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-ink-slate">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="collected">Collected</option><option value="failed">Failed</option></select></label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
        </div>
        {err && <div className="mt-2 text-xs text-red-700">{err}</div>}
        <button onClick={save} disabled={saving} className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-4 py-2.5 rounded-lg disabled:opacity-60">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save payment
        </button>
      </div>
    </div>
  );
}
