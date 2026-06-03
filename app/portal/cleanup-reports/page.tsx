import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { PortalErrorState } from "../error-state";
import { FileText, Download, Calendar, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Portal · Cleanup Reports
 *
 * Lists every completed bookkeeping cleanup period for this client and
 * lets them download the same branded PDF report Mike sends after each
 * cleanup. Auth-scoped to the signed-in portal user's client via
 * resolvePortalContext — clients never see other clients' reports.
 *
 * What constitutes "a cleanup period":
 *   - A reclass_jobs row with status='complete' AND month_closed_at set
 *     (= formally closed period — most authoritative signal)
 *   - Plus any non-month-close reclass_jobs that completed (for clients
 *     who haven't adopted the formal month-close workflow yet)
 *
 * Periods are deduplicated by (date_range_start, date_range_end) — if
 * the bookkeeper ran multiple jobs over the same window we surface the
 * window once, not per-job.
 */
export default async function PortalCleanupReportsPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok)
    return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase();

  // Pull every completed reclass job for this client. We bucket by window
  // afterwards so multiple jobs over the same period collapse to one card.
  // Cast through `any` because month_closed_at + status are present in the
  // real schema but stale in the generated types — same pattern used
  // elsewhere in this codebase.
  const { data: rawJobs } = await (service as any)
    .from("reclass_jobs")
    .select(
      "id, status, workflow, date_range_start, date_range_end, month_closed_at, execution_completed_at, created_at"
    )
    .eq("client_link_id", ctx.clientLinkId)
    .eq("status", "complete")
    .order("date_range_end", { ascending: false, nullsFirst: false });

  const jobs = (rawJobs || []) as Array<{
    id: string;
    workflow: string | null;
    date_range_start: string | null;
    date_range_end: string | null;
    month_closed_at: string | null;
    execution_completed_at: string | null;
    created_at: string | null;
  }>;

  // Bucket by (start, end) — same window, multiple jobs = one card.
  const buckets = new Map<
    string,
    {
      start: string;
      end: string;
      jobCount: number;
      monthClosed: boolean;
      latestCompletedAt: string | null;
      workflows: Set<string>;
    }
  >();
  for (const j of jobs) {
    if (!j.date_range_start || !j.date_range_end) continue;
    const key = `${j.date_range_start}_${j.date_range_end}`;
    const existing = buckets.get(key);
    const completedAt = j.execution_completed_at || j.month_closed_at || j.created_at;
    if (existing) {
      existing.jobCount++;
      if (j.month_closed_at) existing.monthClosed = true;
      if (j.workflow) existing.workflows.add(j.workflow);
      if (completedAt && (!existing.latestCompletedAt || completedAt > existing.latestCompletedAt)) {
        existing.latestCompletedAt = completedAt;
      }
    } else {
      buckets.set(key, {
        start: j.date_range_start,
        end: j.date_range_end,
        jobCount: 1,
        monthClosed: !!j.month_closed_at,
        latestCompletedAt: completedAt,
        workflows: new Set(j.workflow ? [j.workflow] : []),
      });
    }
  }
  const periods = Array.from(buckets.values()).sort((a, b) =>
    b.end.localeCompare(a.end)
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">
          Cleanup Reports
        </div>
        <h1 className="text-3xl font-bold text-navy mt-1">
          Your bookkeeping cleanup history
        </h1>
        <div className="text-sm text-ink-slate mt-1">
          Branded PDF reports for every period your books were cleaned up.
          Share them with your accountant, lender, or tax preparer — they show
          exactly what was reviewed and reconciled.
        </div>
      </div>

      {periods.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center">
          <FileText size={32} className="mx-auto text-ink-slate mb-3" />
          <div className="text-sm font-semibold text-navy">
            No cleanup reports available yet
          </div>
          <p className="text-xs text-ink-slate mt-2 max-w-md mx-auto">
            Once Ironbooks completes a bookkeeping cleanup for a period, the
            report will appear here automatically. Reach out to your
            bookkeeper if you expected one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {periods.map((p) => {
            const downloadUrl = `/api/portal/cleanup-report?start=${p.start}&end=${p.end}`;
            const filename = `Ironbooks Cleanup ${p.start} to ${p.end}.pdf`;
            return (
              <div
                key={`${p.start}_${p.end}`}
                className="bg-white border border-gray-200 rounded-2xl p-4 md:p-5 flex items-center justify-between gap-4 flex-wrap hover:border-teal-light transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-teal-lighter flex items-center justify-center">
                    <FileText size={18} className="text-teal" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-bold text-navy">
                        {formatPeriodLabel(p.start, p.end)}
                      </div>
                      {p.monthClosed && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                          <CheckCircle2 size={10} />
                          Month closed
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-slate mt-1 flex items-center gap-2 flex-wrap">
                      <Calendar size={12} />
                      {p.start} → {p.end}
                      {p.latestCompletedAt && (
                        <>
                          <span className="text-ink-slate/50">·</span>
                          <span>
                            Finalized{" "}
                            {new Date(p.latestCompletedAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <a
                  href={downloadUrl}
                  download={filename}
                  className="shrink-0 inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
                >
                  <Download size={14} />
                  Download PDF
                </a>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[11px] text-ink-slate/70 max-w-2xl">
        PDFs are generated on-demand from your live QuickBooks data and the
        Ironbooks cleanup audit trail for the requested period. The files are
        not stored — each download is freshly built.
      </div>
    </div>
  );
}

/** Render "January 2026" if the range is a clean calendar month, else
 *  "Jan 15 → Mar 31, 2026". Saves the client from squinting at YYYY-MM-DD. */
function formatPeriodLabel(start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const sameMonth =
    s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  const firstOfMonth = s.getUTCDate() === 1;
  const lastOfMonth = e.getUTCDate() >= 28 && new Date(e.getUTCFullYear(), e.getUTCMonth() + 1, 0).getUTCDate() === e.getUTCDate();

  if (sameMonth && firstOfMonth && lastOfMonth) {
    // Clean calendar month
    return s.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  }

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const yearSuffix =
    s.getUTCFullYear() === e.getUTCFullYear() ? `, ${e.getUTCFullYear()}` : "";
  return `${fmt(s)} → ${fmt(e)}${yearSuffix}`;
}
