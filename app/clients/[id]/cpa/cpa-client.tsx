"use client";

import { useEffect, useState } from "react";
import {
  Scale, FileSpreadsheet, BookOpenCheck, Landmark, Loader2, Trash2,
  Play, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, ArrowLeft,
} from "lucide-react";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const FILING_LABELS: Record<string, string> = {
  gst_hst: "GST/HST",
  source_deductions: "Source deductions",
  corp_tax: "Corporate tax",
};

export function CpaClient({ clientId, company }: { clientId: string; company: string }) {
  const [data, setData] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/clients/${clientId}/cpa`);
      const j = await res.json();
      if (res.ok) setData(j);
      else setBanner({ kind: "err", text: j.error || "Failed to load" });
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message });
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function act(body: any, key: string, okMsg?: string) {
    setBusy(key); setBanner(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/cpa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) { setBanner({ kind: "err", text: j.error || "Request failed" }); return null; }
      if (okMsg) setBanner({ kind: "ok", text: okMsg });
      await load();
      return j;
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <div>
        <a href={`/clients/${clientId}`} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-slate hover:text-navy mb-2">
          <ArrowLeft size={12} /> Back to client
        </a>
        <h1 className="text-2xl font-bold text-navy flex items-center gap-2">
          <Scale size={22} className="text-teal" /> CPA Round-Trip — {company}
        </h1>
        <p className="text-sm text-ink-slate mt-1 max-w-3xl">
          Close the loop with the accountant: diff their closing trial balance against QBO, enter
          their adjusting entries, and tie filed tax amounts to the ledger.
        </p>
      </div>

      {banner && (
        <div className={`p-3 rounded-lg text-sm border ${banner.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"}`}>
          {banner.text}
        </div>
      )}

      <TbSection data={data} busy={busy} act={act} />
      <AjeSection data={data} busy={busy} act={act} />
      <FilingSection data={data} busy={busy} act={act} />
    </div>
  );
}

// ─── 1. Closing trial balance ───────────────────────────────────────────────

function TbSection({ data, busy, act }: any) {
  const [csv, setCsv] = useState("");
  const [asOf, setAsOf] = useState("");
  const [label, setLabel] = useState("");
  const [openDiff, setOpenDiff] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-bold text-navy flex items-center gap-2"><FileSpreadsheet size={16} className="text-teal" /> Closing trial balance vs QBO</h2>
        <p className="text-xs text-ink-slate mt-0.5">
          Paste the CPA's closing TB (columns: Account, Debit, Credit — or Account, Balance). Diff runs against the live
          QBO trial balance as of the same date, account by account.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={5}
          placeholder={"Account,Debit,Credit\nChequing - RBC,12500.00,\nGST/HST Payable,,3214.50\n…"}
          className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-gray-200"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs font-semibold text-ink-slate">As of
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="ml-2 px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
          </label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. FY2025 closing from Smith CPA)" className="flex-1 min-w-[220px] px-3 py-1.5 text-xs border border-gray-200 rounded-lg" />
          <button
            onClick={() => act({ action: "import_tb", as_of_date: asOf, label, csv_text: csv }, "import_tb", "Trial balance imported.").then((r: any) => { if (r) { setCsv(""); setLabel(""); } })}
            disabled={!csv.trim() || !asOf || busy === "import_tb"}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-lg"
          >
            {busy === "import_tb" ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />} Import TB
          </button>
        </div>

        {(data?.imports || []).map((imp: any) => (
          <div key={imp.id} className="rounded-lg border border-gray-200">
            <div className="flex items-center gap-3 px-3 py-2">
              <button onClick={() => setOpenDiff(openDiff === imp.id ? null : imp.id)} className="text-ink-slate hover:text-navy">
                {openDiff === imp.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-navy">{imp.label || "Closing TB"}</span>
                <span className="text-xs text-ink-slate"> · as of {imp.as_of_date} · {imp.row_count} accounts</span>
                {imp.last_diff?.summary && (
                  <span className={`ml-2 text-[11px] font-semibold px-2 py-0.5 rounded-full ${imp.last_diff.summary.variance + imp.last_diff.summary.cpa_only + imp.last_diff.summary.qbo_only === 0 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                    {imp.last_diff.summary.variance + imp.last_diff.summary.cpa_only + imp.last_diff.summary.qbo_only === 0
                      ? "AGREES ✓"
                      : `${imp.last_diff.summary.variance} variances · ${money(imp.last_diff.summary.total_abs_diff)} total`}
                  </span>
                )}
              </div>
              {(["Accrual", "Cash"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => act({ action: "diff_tb", import_id: imp.id, basis: b }, `diff-${imp.id}-${b}`).then(() => setOpenDiff(imp.id))}
                  disabled={busy === `diff-${imp.id}-${b}`}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-teal border border-teal/30 hover:bg-teal-lighter rounded-md px-2 py-1"
                >
                  {busy === `diff-${imp.id}-${b}` ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Diff ({b})
                </button>
              ))}
              <button onClick={() => { if (confirm("Delete this TB import?")) act({ action: "delete_tb", import_id: imp.id }, `del-${imp.id}`); }} className="p-1 text-ink-light hover:text-red-600"><Trash2 size={13} /></button>
            </div>
            {openDiff === imp.id && imp.last_diff?.rows && (
              <div className="border-t border-gray-100 max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="text-left text-ink-light">
                      <th className="px-3 py-1.5">CPA account</th><th className="px-3 py-1.5">QBO account</th>
                      <th className="px-3 py-1.5 text-right">CPA</th><th className="px-3 py-1.5 text-right">QBO</th>
                      <th className="px-3 py-1.5 text-right">Diff</th><th className="px-3 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {imp.last_diff.rows.filter((r: any) => r.status !== "matched").map((r: any, i: number) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5">{r.cpa_account || <span className="text-ink-light">—</span>}</td>
                        <td className="px-3 py-1.5">{r.qbo_account || <span className="text-ink-light">—</span>}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.cpa_amount)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(r.qbo_amount)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${Math.abs(r.diff) > 0.01 ? "text-red-700" : ""}`}>{money(r.diff)}</td>
                        <td className="px-3 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.status === "variance" ? "bg-amber-100 text-amber-800" : r.status === "cpa_only" ? "bg-red-100 text-red-800" : "bg-blue-100 text-blue-800"}`}>{r.status.replace("_", " ")}</span>
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-gray-200 bg-gray-50">
                      <td colSpan={6} className="px-3 py-1.5 text-ink-slate">
                        {imp.last_diff.summary.matched} matched · {imp.last_diff.summary.variance} variances · {imp.last_diff.summary.cpa_only} CPA-only · {imp.last_diff.summary.qbo_only} QBO-only · basis {imp.last_diff.basis}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── 2. CPA adjusting entries ───────────────────────────────────────────────

function AjeSection({ data, busy, act }: any) {
  const [csv, setCsv] = useState("");
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-bold text-navy flex items-center gap-2"><BookOpenCheck size={16} className="text-teal" /> CPA adjusting entries</h2>
        <p className="text-xs text-ink-slate mt-0.5">
          Paste the accountant's AJEs (columns: Entry, Date, Account, Debit, Credit, Memo). Import stages them; Post
          writes balanced entries to QBO as journal entries (idempotent — re-posting never duplicates).
        </p>
      </div>
      <div className="p-5 space-y-3">
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={5}
          placeholder={"Entry,Date,Account,Debit,Credit,Memo\n1,2025-12-31,Amortization Expense,4200.00,,Annual amortization\n1,2025-12-31,Accumulated Amortization,,4200.00,Annual amortization"}
          className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-gray-200"
        />
        <div className="flex items-center gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. FY2025 AJEs from Smith CPA)" className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg" />
          <button
            onClick={() => act({ action: "import_ajes", label, csv_text: csv }, "import_ajes", "AJEs imported — review, then Post.").then((r: any) => { if (r) { setCsv(""); setLabel(""); } })}
            disabled={!csv.trim() || busy === "import_ajes"}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-lg"
          >
            {busy === "import_ajes" ? <Loader2 size={13} className="animate-spin" /> : <BookOpenCheck size={13} />} Import AJEs
          </button>
        </div>

        {(data?.batches || []).map((b: any) => {
          const resultByKey = new Map(((b.post_results || []) as any[]).map((r) => [r.key, r]));
          return (
            <div key={b.id} className="rounded-lg border border-gray-200">
              <div className="flex items-center gap-3 px-3 py-2">
                <button onClick={() => setOpen(open === b.id ? null : b.id)} className="text-ink-slate hover:text-navy">
                  {open === b.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-semibold text-navy">{b.label || "AJE batch"}</span>
                  <span className="text-xs text-ink-slate"> · {b.entry_count} entr{b.entry_count === 1 ? "y" : "ies"} · {b.posted_count} posted</span>
                </div>
                <button
                  onClick={() => { if (confirm(`Post the balanced entries in "${b.label || "this batch"}" to QBO as journal entries?`)) act({ action: "post_ajes", batch_id: b.id }, `post-${b.id}`, "Batch posted — see per-entry results."); }}
                  disabled={busy === `post-${b.id}`}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-navy hover:bg-ink-light rounded-md px-2.5 py-1"
                >
                  {busy === `post-${b.id}` ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Post to QBO
                </button>
                {b.posted_count === 0 && (
                  <button onClick={() => { if (confirm("Delete this batch?")) act({ action: "delete_batch", batch_id: b.id }, `delb-${b.id}`); }} className="p-1 text-ink-light hover:text-red-600"><Trash2 size={13} /></button>
                )}
              </div>
              {open === b.id && (
                <div className="border-t border-gray-100 divide-y divide-gray-100">
                  {(b.entries || []).map((e: any) => {
                    const res: any = resultByKey.get(e.key);
                    return (
                      <div key={e.key} className="px-4 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-navy">#{e.key}</span>
                          <span className="text-ink-slate">{e.txn_date || "no date"}{e.memo ? ` · ${e.memo}` : ""}</span>
                          {!e.balanced && <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700"><AlertTriangle size={11} /> doesn't balance</span>}
                          {res && (
                            <span className={`ml-auto inline-flex items-center gap-1 text-[10px] font-semibold ${res.status === "posted" ? "text-emerald-700" : res.status === "failed" ? "text-red-700" : "text-amber-700"}`}>
                              {res.status === "posted" ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                              {res.status}{res.qbo_je_id ? ` (JE ${res.qbo_je_id})` : ""}{res.reason ? ` — ${res.reason}` : ""}
                            </span>
                          )}
                        </div>
                        <table className="mt-1 w-full">
                          <tbody>
                            {e.lines.map((l: any, i: number) => (
                              <tr key={i} className="text-ink-slate">
                                <td className="py-0.5">{l.account}</td>
                                <td className="py-0.5 text-right tabular-nums w-24">{l.debit ? money(l.debit) : ""}</td>
                                <td className="py-0.5 text-right tabular-nums w-24">{l.credit ? money(l.credit) : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── 3. Filed amounts tie-out ───────────────────────────────────────────────

function FilingSection({ data, busy, act }: any) {
  const [type, setType] = useState("gst_hst");
  const [periodEnd, setPeriodEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const tieByFiling = new Map(((data?.tie_outs || []) as any[]).map((t) => [t.filing_id, t]));

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="px-5 py-4 border-b border-gray-200">
        <h2 className="font-bold text-navy flex items-center gap-2"><Landmark size={16} className="text-teal" /> Filed amounts — statutory tie-out</h2>
        <p className="text-xs text-ink-slate mt-0.5">
          Record what was actually filed/remitted; SNAP compares it to the matching ledger liability accounts live.
          Enter liability owed as NEGATIVE (matches how QBO carries it).
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select value={type} onChange={(e) => setType(e.target.value)} className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white">
            <option value="gst_hst">GST/HST</option>
            <option value="source_deductions">Source deductions</option>
            <option value="corp_tax">Corporate tax</option>
          </select>
          <label className="text-xs font-semibold text-ink-slate">Period end
            <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="ml-2 px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
          </label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" placeholder="Filed amount (owed = negative)" className="w-56 px-3 py-1.5 text-xs border border-gray-200 rounded-lg" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="flex-1 min-w-[160px] px-3 py-1.5 text-xs border border-gray-200 rounded-lg" />
          <button
            onClick={() => act({ action: "record_filing", filing_type: type, period_end: periodEnd, filed_amount: Number(amount), note }, "record_filing", "Filing recorded.").then((r: any) => { if (r) { setAmount(""); setNote(""); } })}
            disabled={!periodEnd || amount === "" || busy === "record_filing"}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-xs font-bold px-4 py-2 rounded-lg"
          >
            {busy === "record_filing" ? <Loader2 size={13} className="animate-spin" /> : <Landmark size={13} />} Record
          </button>
        </div>

        {(data?.filings || []).length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-light border-b border-gray-200">
                <th className="py-1.5">Filing</th><th className="py-1.5">Period end</th>
                <th className="py-1.5 text-right">Filed</th><th className="py-1.5 text-right">Ledger</th>
                <th className="py-1.5 text-right">Variance</th><th className="py-1.5">Ledger accounts</th><th />
              </tr>
            </thead>
            <tbody>
              {(data.filings as any[]).map((f) => {
                const tie: any = tieByFiling.get(f.id);
                const ok = tie && Math.abs(tie.variance) <= 0.01;
                return (
                  <tr key={f.id} className="border-b border-gray-100">
                    <td className="py-1.5 font-semibold text-navy">{FILING_LABELS[f.filing_type] || f.filing_type}</td>
                    <td className="py-1.5">{f.period_end}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(Number(f.filed_amount))}</td>
                    <td className="py-1.5 text-right tabular-nums">{tie ? money(tie.ledger_total) : "—"}</td>
                    <td className={`py-1.5 text-right tabular-nums font-bold ${tie ? (ok ? "text-emerald-700" : "text-red-700") : ""}`}>
                      {tie ? (ok ? "ties ✓" : money(tie.variance)) : "—"}
                    </td>
                    <td className="py-1.5 text-ink-light">{tie ? tie.accounts.map((a: any) => a.name).join(", ") || "(none matched)" : ""}</td>
                    <td className="py-1.5 text-right">
                      <button onClick={() => { if (confirm("Delete this filing record?")) act({ action: "delete_filing", filing_id: f.id }, `delf-${f.id}`); }} className="p-1 text-ink-light hover:text-red-600"><Trash2 size={12} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
