"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Loader2, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";

type Row = {
  client_link_id: string;
  client_name: string;
  total_rules: number;
  not_downloaded: number;
  last_downloaded_at: string | null;
  status: "not_downloaded" | "downloaded";
};
type Summary = { clients_with_rules: number; not_downloaded: number; total_rules: number };

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never";

export function BankRulesFleetClient() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [onlyNotDownloaded, setOnlyNotDownloaded] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadErr, setDownloadErr] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/admin/bank-rules-fleet")
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) { setError(j.error || "Failed to load"); setRows([]); return; }
        setRows(j.rows || []);
        setSummary(j.summary || null);
      })
      .catch((e) => { setError(e?.message || "Load failed"); setRows([]); });
  }, []);

  const visible = useMemo(
    () => (rows || []).filter((r) => (onlyNotDownloaded ? r.status === "not_downloaded" : true)),
    [rows, onlyNotDownloaded]
  );

  async function download(row: Row) {
    setDownloading(row.client_link_id);
    setDownloadErr((e) => ({ ...e, [row.client_link_id]: "" }));
    try {
      const res = await fetch(`/api/rules/export-qbo/${row.client_link_id}`);
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Download failed (${res.status})`);
      }
      const disp = res.headers.get("content-disposition") || "";
      const m = disp.match(/filename="?([^"]+)"?/);
      const filename = m?.[1] || `${row.client_name.replace(/[^a-z0-9]+/gi, "_")}_Bank_Feed_Rules.xls`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setDownloadErr((er) => ({ ...er, [row.client_link_id]: e?.message || "Download failed" }));
    } finally {
      setDownloading(null);
    }
  }

  if (rows === null) {
    return <div className="flex items-center gap-2 text-sm text-ink-slate"><Loader2 size={15} className="animate-spin" /> Scanning the fleet…</div>;
  }

  return (
    <div>
      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Stat label="Clients with rules" value={summary.clients_with_rules} />
          <Stat label="Not downloaded" value={summary.not_downloaded} tone={summary.not_downloaded > 0 ? "amber" : "ok"} />
          <Stat label="Total SNAP rules" value={summary.total_rules} />
        </div>
      )}

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 mb-4 text-xs text-amber-900 flex items-start gap-2">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        <span>
          Downloading a client&apos;s .xls is what marks its rules exported — so if the .xls was
          <strong> never downloaded, assume the rules were never applied</strong> in QBO. To apply: download below,
          clear the client&apos;s old rules in QBO (Banking → Rules → select-all → Delete), then import. QBO import
          <em> appends</em>, so the clear-first step matters.
        </span>
      </div>

      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-navy cursor-pointer">
          <input type="checkbox" checked={onlyNotDownloaded} onChange={(e) => setOnlyNotDownloaded(e.target.checked)} className="h-3.5 w-3.5 accent-teal" />
          Only show clients not fully downloaded
        </label>
        <span className="text-[11px] text-ink-light">{visible.length} shown</span>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-light border-b border-gray-100">
              <th className="text-left px-4 py-2.5 font-bold">Client</th>
              <th className="text-right px-3 py-2.5 font-bold">Rules</th>
              <th className="text-right px-3 py-2.5 font-bold">Not downloaded</th>
              <th className="text-left px-3 py-2.5 font-bold hidden sm:table-cell">Last download</th>
              <th className="text-right px-4 py-2.5 font-bold"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {visible.map((r) => (
              <tr key={r.client_link_id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <Link href={`/clients/${r.client_link_id}`} className="font-semibold text-navy hover:text-teal-dark hover:underline">
                    {r.client_name}
                  </Link>
                  {r.status === "downloaded" ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700"><CheckCircle2 size={10} /> downloaded</span>
                  ) : (
                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700"><AlertTriangle size={10} /> not downloaded</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-navy">{r.total_rules}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${r.not_downloaded > 0 ? "text-amber-700" : "text-ink-light"}`}>{r.not_downloaded}</td>
                <td className="px-3 py-2.5 text-ink-slate whitespace-nowrap hidden sm:table-cell">{fmtDate(r.last_downloaded_at)}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => download(r)}
                    disabled={downloading === r.client_link_id}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal border border-teal/30 hover:bg-teal/5 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
                  >
                    {downloading === r.client_link_id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    .xls
                  </button>
                  {downloadErr[r.client_link_id] && (
                    <div className="text-[10px] text-red-600 mt-1">{downloadErr[r.client_link_id]}</div>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-light">
                {onlyNotDownloaded ? "Every client's SNAP rules have been downloaded. ✓" : "No clients have SNAP rules yet."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-ink-light mt-3 flex items-center gap-1.5">
        Download a client&apos;s .xls to amend, then import in QuickBooks:
        <span className="font-semibold text-ink-slate">Banking → Rules → ⋮ → Import Rules</span>
        <a href="https://app.qbo.intuit.com/app/banking?tab=rules" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-dark hover:underline">open QBO ↗</a>
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "amber" | "ok" }) {
  return (
    <div className="rounded-xl bg-white border border-gray-200 px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${tone === "amber" ? "text-amber-600" : "text-navy"}`}>{value}</div>
    </div>
  );
}
