"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2, FileText, RotateCcw, Loader2, ChevronDown, ChevronRight,
  Factory, AlertTriangle, ArrowRight,
} from "lucide-react";

interface CompletedClient {
  id: string;
  client_name: string;
  jurisdiction: "US" | "CA";
  state_province: string | null;
  daily_recon_enabled: boolean;
  cleanup_completed_at: string;
  cleanup_range_start: string | null;
  cleanup_range_end: string | null;
  cleanup_completion_note: string | null;
}

/**
 * "Cleanup complete" partition at the bottom of the clients page — clients
 * whose initial cleanup has been signed off. Approving a cleanup graduates
 * them to Production (daily recon on), so the section is framed around that:
 * each row shows its production status, and the header links to the
 * Production board where they're maintained month by month.
 *
 * Each row still supports two actions:
 *
 *  • Download PDF — re-pulls the branded cleanup report for the saved
 *    date range. The endpoint requires start/end query params, which we
 *    captured at mark-complete time so the bookkeeper doesn't have to
 *    re-pick dates.
 *
 *  • Reopen — clears the completion marker on client_links and bumps
 *    the row back into the active grid above. Used when more work
 *    surfaces later (a re-cleanup, an audit ask, etc.).
 */
export function CompletedAccounts({
  clients,
  canEdit,
}: {
  clients: CompletedClient[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [reopening, setReopening] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  async function handleReopen(c: CompletedClient) {
    if (!confirm(
      `Reopen ${c.client_name}?\n\n` +
      `• The client will move back to the active list at the top.\n` +
      `• Completion history is cleared (date range, note, who completed it).\n` +
      `• You can mark it complete again after the next cleanup.`
    )) return;

    setReopening(c.id);
    setError("");
    try {
      const res = await fetch(`/api/clients/${c.id}/complete-cleanup`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.refresh();
    } catch (e: any) {
      setError(`${c.client_name}: ${e.message || "Failed to reopen"}`);
      setReopening(null);
    }
  }

  function pdfHref(c: CompletedClient) {
    const params = new URLSearchParams();
    if (c.cleanup_range_start) params.set("start", c.cleanup_range_start);
    if (c.cleanup_range_end) params.set("end", c.cleanup_range_end);
    return `/api/reports/cleanup/${c.id}?${params.toString()}`;
  }

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const inProductionCount = clients.filter((c) => c.daily_recon_enabled).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100">
      <div className="flex items-center justify-between px-6 py-4 gap-3">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left -my-4 py-4 hover:opacity-80"
        >
          <CheckCircle2 className="text-green-600 flex-shrink-0" size={18} />
          <div className="min-w-0">
            <div className="text-sm font-bold text-navy">
              Cleanup complete ({clients.length})
            </div>
            <div className="text-xs text-ink-slate">
              Cleanup signed off — {inProductionCount === clients.length
                ? "all graduated to Production and maintained monthly there."
                : `${inProductionCount} of ${clients.length} graduated to Production.`}{" "}
              PDF report and reopen stay available.
            </div>
          </div>
        </button>
        <div className="flex items-center gap-3 flex-shrink-0">
          <Link
            href="/production"
            className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark"
            title="Open the Production board"
          >
            <Factory size={14} />
            Production board
            <ArrowRight size={12} />
          </Link>
          <button onClick={() => setOpen(!open)} className="text-ink-slate" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-100">
          {error && (
            <div className="m-4 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              {error}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
                  <th className="px-6 py-3">Client</th>
                  <th className="px-6 py-3">Completed</th>
                  <th className="px-6 py-3">Cleanup range</th>
                  <th className="px-6 py-3">Note</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-navy">{c.client_name}</span>
                        {c.daily_recon_enabled ? (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                            style={{ color: "#047857", backgroundColor: "#D1FAE5" }}
                            title="Live in Production — daily recon runs nightly and they're on the monthly close board."
                          >
                            <Factory size={9} /> In production
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                            style={{ color: "#B45309", backgroundColor: "#FEF3C7" }}
                            title="Cleanup is signed off but this client hasn't been promoted to Production yet. Promote them from the Production board."
                          >
                            <AlertTriangle size={9} /> Not promoted
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-light">
                        {c.jurisdiction}
                        {c.state_province ? ` · ${c.state_province}` : ""}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-ink-slate">
                      {fmtDate(c.cleanup_completed_at)}
                    </td>
                    <td className="px-6 py-3 text-ink-slate">
                      {c.cleanup_range_start && c.cleanup_range_end ? (
                        <span className="font-mono text-xs">
                          {c.cleanup_range_start} → {c.cleanup_range_end}
                        </span>
                      ) : (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-ink-slate max-w-xs truncate">
                      {c.cleanup_completion_note || (
                        <span className="text-ink-light">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {c.cleanup_range_start && c.cleanup_range_end ? (
                          <a
                            href={pdfHref(c)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal hover:text-teal-dark"
                            title="Download cleanup report PDF"
                          >
                            <FileText size={14} />
                            PDF
                          </a>
                        ) : (
                          <span
                            className="text-xs text-ink-light"
                            title="No saved date range; reopen and re-mark complete after a job runs to enable the PDF."
                          >
                            (no PDF)
                          </span>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => handleReopen(c)}
                            disabled={reopening === c.id}
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-slate hover:text-navy disabled:opacity-60"
                            title="Reopen cleanup — moves the client back to the active list"
                          >
                            {reopening === c.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <RotateCcw size={14} />
                            )}
                            Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
