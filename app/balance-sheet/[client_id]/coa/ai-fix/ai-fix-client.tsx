"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { playSound } from "@/lib/sounds";
import {
  Sparkles, Loader2, AlertTriangle, CheckCircle2, X, RefreshCw,
  ChevronDown, ChevronRight, Send, Check, AlertCircle, Zap, Clock,
  ArrowLeft, ArrowRight,
} from "lucide-react";

interface Run {
  id: string;
  status: string;
  created_at: string;
  issues_count: number;
  accepted_count: number;
  modified_count: number;
  rejected_count: number;
  total_estimated_impact: number;
  ai_summary: string | null;
  ai_warnings: any;
  duration_ms: number | null;
  finalized_at: string | null;
  finalize_results: any;
  error_message: string | null;
  snapshot_summary: any;
}

interface Item {
  id: string;
  run_id: string;
  kind: string;
  account_qbo_id: string | null;
  account_name: string | null;
  description: string;
  ai_reasoning: string;
  proposed_fix: any;
  modified_fix: any | null;
  confidence: number;
  risk: "low" | "medium" | "high";
  estimated_impact: number;
  decision: string;
  decided_at: string | null;
  executed_at: string | null;
  execution_error: string | null;
}

export function BsAiFixClient({
  clientLinkId,
  clientName,
  latestRun,
}: {
  clientLinkId: string;
  clientName: string;
  latestRun: Run | null;
}) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(latestRun);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState("");

  // Load items when we have a run
  async function loadRun(rId: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-ai-fix/${rId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setRun(body.run);
      setItems(body.items || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load run");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (latestRun && latestRun.id && latestRun.status !== "analyzing") {
      loadRun(latestRun.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestRun?.id]);

  async function analyze() {
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch(`/api/clients/${clientLinkId}/bs-ai-fix/analyze`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadRun(body.run_id);
      playSound("scan_complete");
    } catch (e: any) {
      setError(e?.message || "Analyze failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function decide(item: Item, decision: string, modifiedFix?: any) {
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/bs-ai-fix/${item.run_id}/item/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, modified_fix: modifiedFix }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `HTTP ${res.status}`);
        return;
      }
      // Optimistic local update
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? {
                ...i,
                decision,
                modified_fix: modifiedFix || i.modified_fix,
                decided_at: new Date().toISOString(),
              }
            : i
        )
      );
    } catch (e: any) {
      setError(e?.message || "Decision update failed");
    }
  }

  async function finalize() {
    if (!run) return;
    const acceptedCount = items.filter((i) =>
      ["accepted", "modified"].includes(i.decision)
    ).length;
    if (acceptedCount === 0) {
      setError("Nothing to finalize — accept at least one fix first.");
      return;
    }
    if (
      !confirm(
        `Finalize ${acceptedCount} fix${acceptedCount === 1 ? "" : "es"}?\n\n` +
          "This will:\n" +
          "  • Reclassify transaction lines per accepted Reclass fixes\n" +
          "  • Post journal entries per accepted JE fixes\n" +
          "  • Mark flagged items as acknowledged (no QBO write)\n\n" +
          "Each operation has its own try/catch — one failure won't poison the batch."
      )
    )
      return;

    setFinalizing(true);
    setError("");
    try {
      const res = await fetch(
        `/api/clients/${clientLinkId}/bs-ai-fix/${run.id}/finalize`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadRun(run.id);
      if (body.failed && body.failed > 0) {
        playSound("finalize_failed");
      }
    } catch (e: any) {
      setError(e?.message || "Finalize failed");
      playSound("finalize_failed");
    } finally {
      setFinalizing(false);
    }
  }

  // Bulk action: apply a decision to every item matching a predicate.
  async function bulkDecide(predicate: (item: Item) => boolean, decision: string) {
    const targets = items.filter(predicate);
    if (targets.length === 0) return;
    // Optimistic UI — flip locally then sync each to the server
    setItems((prev) =>
      prev.map((i) =>
        predicate(i) ? { ...i, decision, decided_at: new Date().toISOString() } : i
      )
    );
    // Fire all PATCHes in parallel; partial failures are fine
    const results = await Promise.allSettled(
      targets.map((t) =>
        fetch(`/api/clients/${clientLinkId}/bs-ai-fix/${t.run_id}/item/${t.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        })
      )
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      setError(`${failed} bulk update${failed === 1 ? "" : "s"} failed — refreshing`);
    }
    if (run) loadRun(run.id);
  }

  // ── STAGE 1: no run yet, or last run was failed/finalized → show Analyze ──
  const isFresh =
    !run || run.status === "failed" || run.status === "finalized" || run.status === "cancelled";

  if (isFresh && !analyzing) {
    return (
      <div className="space-y-4">
        {error && <ErrorBanner msg={error} onClose={() => setError("")} />}

        <div className="bg-gradient-to-br from-teal-lighter to-white border border-teal/30 rounded-2xl p-6 space-y-3">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-teal-light flex-shrink-0">
              <Sparkles size={20} className="text-teal" />
            </div>
            <div className="flex-1">
              <h2 className="font-bold text-navy">
                {run ? "Run another AI cleanup pass" : "Start AI BS cleanup"}
              </h2>
              <p className="text-sm text-ink-slate mt-1 leading-relaxed">
                Snapshots {clientName}&apos;s full Balance Sheet, then has Claude review
                Undeposited Funds, Opening Balance Equity, Suspense / Ask My Accountant,
                stale uncleared bank lines, and A/R + A/P aging. Returns a prioritized
                list of proposed fixes you can accept, modify, or reject before they
                ship to QBO.
              </p>
            </div>
          </div>
          <button
            onClick={analyze}
            disabled={analyzing}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-60"
          >
            {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {run ? "Re-analyze" : "Auto-match — analyze BS"}
          </button>
          <p className="text-[11px] text-ink-light">
            Costs one Claude Opus call (~10-30s). Pre-accepts high-confidence low-risk
            items so you usually only have to click through the medium-risk ones.
          </p>
        </div>

        {run && run.status === "finalized" && (
          <FinalizedRunSummary run={run} items={items} />
        )}
        {run && run.status === "failed" && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-2xl text-sm">
            <div className="font-semibold text-red-900 mb-1">Previous run failed</div>
            <div className="text-red-800 text-xs">{run.error_message || "(no error message)"}</div>
          </div>
        )}
      </div>
    );
  }

  // ── STAGE 1.5: analyzing in flight ──
  if (analyzing || (run && run.status === "analyzing")) {
    // Show a "stuck" escape hatch after 90s — the typical analyze finishes
    // in 10-30s, so anything past 90s likely means the function crashed
    // mid-call. The server's stale-run sweep will also catch this in 5min,
    // but we don't want the UI hostage for that long.
    const elapsedSec = run
      ? Math.floor((Date.now() - new Date(run.created_at).getTime()) / 1000)
      : 0;
    const stuck = elapsedSec > 90;
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-3">
        <Loader2 className="animate-spin text-teal mx-auto" size={36} />
        <div className="font-semibold text-navy">Analyzing Balance Sheet…</div>
        <p className="text-sm text-ink-slate max-w-md mx-auto">
          {stuck
            ? `This is taking longer than usual (${elapsedSec}s). The Claude call may have hung — you can force a reset and try again.`
            : "Pulling every BS account + recent transactions on suspect ones, then asking Claude to identify cleanup issues. Typically 10-30 seconds."}
        </p>
        {stuck && (
          <button
            onClick={async () => {
              // Kicking off a fresh analyze auto-fails any stuck >5min run.
              // For sub-5min stuck cases, we just retry — the new analyze
              // creates a new run row even if the old is still 'analyzing'.
              setAnalyzing(false);
              setRun(null);
              setItems([]);
              await analyze();
            }}
            className="inline-flex items-center gap-2 bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold px-4 py-2 rounded-lg text-sm"
          >
            <RefreshCw size={14} />
            Reset and re-analyze
          </button>
        )}
      </div>
    );
  }

  // ── STAGE 2 + 3: review + finalize ──
  if (!run) return null;

  // Smart sort: pending first (so the bookkeeper sees what needs work),
  // within pending by risk (high → low, draws attention to riskiest),
  // then accepted, then rejected. Within each bucket: highest $ impact first.
  const decisionOrder: Record<string, number> = {
    pending: 0,
    modified: 1,
    accepted: 2,
    rejected: 3,
    executed: 4,
    failed: 5,
  };
  const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const da = decisionOrder[a.decision] ?? 99;
      const db = decisionOrder[b.decision] ?? 99;
      if (da !== db) return da - db;
      // Within same decision bucket, sort by risk asc (high first) then impact desc
      const ra = riskOrder[a.risk] ?? 99;
      const rb = riskOrder[b.risk] ?? 99;
      if (ra !== rb) return ra - rb;
      return b.estimated_impact - a.estimated_impact;
    });
  }, [items]);

  const acceptedCount = items.filter((i) =>
    ["accepted", "modified"].includes(i.decision)
  ).length;
  const pendingCount = items.filter((i) => i.decision === "pending").length;
  const totalAcceptedImpact = items
    .filter((i) => ["accepted", "modified"].includes(i.decision))
    .reduce((s, i) => s + i.estimated_impact, 0);
  const hoursOld = run.created_at
    ? (Date.now() - new Date(run.created_at).getTime()) / 3600_000
    : 0;
  const isStale = hoursOld > 24 && run.status !== "finalized";

  return (
    <div className="space-y-4">
      {error && <ErrorBanner msg={error} onClose={() => setError("")} />}

      {/* Run summary */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-teal-light flex-shrink-0">
            <Sparkles size={18} className="text-teal" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-bold text-navy">AI Analysis</h2>
              <RunStatusBadge status={run.status} />
              <span className="text-xs text-ink-slate">
                {formatAgo(run.created_at)} · {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : ""}
              </span>
            </div>
            {run.ai_summary && (
              <p className="text-sm text-ink-slate mt-2 leading-relaxed">{run.ai_summary}</p>
            )}
            {Array.isArray(run.ai_warnings) && run.ai_warnings.length > 0 && (
              <ul className="mt-2 text-xs text-amber-800 space-y-0.5">
                {run.ai_warnings.map((w: string, i: number) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={analyze}
            className="text-xs font-semibold text-ink-slate hover:text-navy inline-flex items-center gap-1"
            title="Discard this run + re-analyze from scratch"
          >
            <RefreshCw size={11} />
            Re-analyze
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3 mt-4 text-center text-sm">
          <Stat label="Issues found" value={run.issues_count} />
          <Stat
            label="Accepted"
            value={items.filter((i) => i.decision === "accepted").length + items.filter((i) => i.decision === "modified").length}
            tone="emerald"
          />
          <Stat
            label="Rejected"
            value={items.filter((i) => i.decision === "rejected").length}
            tone="gray"
          />
          <Stat
            label="Total $ impact"
            value={`$${run.total_estimated_impact.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}`}
          />
        </div>
      </div>

      {/* Stale banner — gentle nudge if the analysis is over a day old */}
      {isStale && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-sm">
          <Clock size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-amber-900">
            <strong>This analysis is {hoursOld < 48 ? "over a day" : `${Math.round(hoursOld / 24)} days`} old.</strong>{" "}
            QBO state may have shifted since then. Consider re-analyzing for a fresh read.
          </div>
          <button
            onClick={analyze}
            disabled={analyzing}
            className="text-xs font-bold text-amber-700 hover:text-amber-900 px-2 py-1 rounded hover:bg-amber-100 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <RefreshCw size={11} />
            Re-analyze
          </button>
        </div>
      )}

      {/* Bulk action toolbar — only shown when there are still pending items
          and the run isn't finalized. Big-win for "fix in minutes" UX. */}
      {pendingCount > 0 && run.status === "review" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-3 flex items-center gap-2 flex-wrap text-xs">
          <Zap size={14} className="text-teal flex-shrink-0" />
          <span className="font-semibold text-navy mr-1">Bulk:</span>
          <button
            onClick={() =>
              bulkDecide(
                (i) =>
                  i.decision === "pending" &&
                  i.risk === "low" &&
                  i.confidence >= 0.85 &&
                  i.proposed_fix?.type !== "flag_for_manual",
                "accepted"
              )
            }
            disabled={finalizing}
            className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            title="Accept every pending item with low risk and ≥85% confidence"
          >
            <Check size={11} /> Accept all low-risk
          </button>
          <button
            onClick={() =>
              bulkDecide(
                (i) =>
                  i.decision === "pending" &&
                  i.proposed_fix?.type === "flag_for_manual",
                "rejected"
              )
            }
            disabled={finalizing}
            className="px-2 py-1 rounded bg-gray-50 border border-gray-200 text-ink-slate hover:bg-gray-100 font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            title="Reject everything AI couldn't auto-fix (flag-for-manual items)"
          >
            <X size={11} /> Reject all flagged-only
          </button>
          <button
            onClick={() =>
              bulkDecide((i) => i.decision === "pending" && i.confidence < 0.7, "rejected")
            }
            disabled={finalizing}
            className="px-2 py-1 rounded bg-gray-50 border border-gray-200 text-ink-slate hover:bg-gray-100 font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            title="Reject every pending item with confidence under 70%"
          >
            <X size={11} /> Reject low-confidence
          </button>
          <span className="ml-auto text-ink-slate">
            <strong className="text-navy">{pendingCount}</strong> pending ·{" "}
            <strong className="text-emerald-700">{acceptedCount}</strong> accepted
          </span>
        </div>
      )}

      {/* Issues list */}
      {items.length === 0 ? (
        <div className="p-8 bg-white rounded-2xl border border-gray-100 text-center text-sm text-ink-slate">
          {loading ? <Loader2 className="animate-spin mx-auto text-teal" size={20} /> : "No issues found — books look clean."}
        </div>
      ) : (
        <div className="space-y-2">
          {sortedItems.map((item) => (
            <IssueCard
              key={item.id}
              item={item}
              runCreatedAt={run.created_at}
              onDecide={decide}
              disabled={finalizing}
            />
          ))}
        </div>
      )}

      {/* Finalize bar — sticky bottom. Breaks down what's about to happen
          by fix type so the bookkeeper sees exactly what hits QBO. */}
      {items.length > 0 && run.status !== "finalized" && (
        <div className="sticky bottom-0 bg-white border-2 border-teal rounded-2xl p-4 shadow-lg flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <div className="font-bold text-navy">
              Ready to finalize {acceptedCount} {acceptedCount === 1 ? "fix" : "fixes"}
              {pendingCount > 0 && (
                <span className="font-normal text-xs text-amber-700 ml-2">
                  · {pendingCount} still pending
                </span>
              )}
            </div>
            <div className="text-xs text-ink-slate mt-0.5 flex items-center gap-3 flex-wrap">
              {(() => {
                const accepted = items.filter((i) =>
                  ["accepted", "modified"].includes(i.decision)
                );
                const reclassCount = accepted.filter(
                  (i) => (i.modified_fix || i.proposed_fix)?.type === "reclass_lines"
                ).length;
                const jeCount = accepted.filter(
                  (i) => (i.modified_fix || i.proposed_fix)?.type === "journal_entry"
                ).length;
                const flagCount = accepted.filter(
                  (i) => (i.modified_fix || i.proposed_fix)?.type === "flag_for_manual"
                ).length;
                return (
                  <>
                    {reclassCount > 0 && (
                      <span>
                        <strong className="text-navy">{reclassCount}</strong> line reclass
                      </span>
                    )}
                    {jeCount > 0 && (
                      <span>
                        <strong className="text-navy">{jeCount}</strong> journal entries
                      </span>
                    )}
                    {flagCount > 0 && (
                      <span>
                        <strong className="text-navy">{flagCount}</strong> manual flags
                      </span>
                    )}
                    <span>
                      $ impact:{" "}
                      <strong className="text-navy">
                        ${totalAcceptedImpact.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </strong>
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
          <button
            onClick={finalize}
            disabled={finalizing || acceptedCount === 0}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-50"
          >
            {finalizing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {finalizing ? "Posting to QBO…" : "Finalize · push to QBO"}
          </button>
        </div>
      )}

      {run.status === "finalized" && (
        <FinalizedRunSummary run={run} items={items} />
      )}
    </div>
  );
}

// ─── HELPERS / SUB-COMPONENTS ──────────────────────────────────────────

function ErrorBanner({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2 text-sm">
      <AlertCircle size={16} className="text-red-700 flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-red-900">{msg}</div>
      <button onClick={onClose} className="text-red-700 hover:text-red-900">
        <X size={14} />
      </button>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: any; tone?: "emerald" | "gray" }) {
  const color =
    tone === "emerald" ? "text-emerald-700" : tone === "gray" ? "text-ink-slate" : "text-navy";
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-ink-slate mt-0.5">{label}</div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    analyzing: { color: "bg-blue-100 text-blue-700", label: "Analyzing" },
    review: { color: "bg-amber-100 text-amber-700", label: "Review" },
    finalizing: { color: "bg-blue-100 text-blue-700", label: "Finalizing" },
    finalized: { color: "bg-emerald-100 text-emerald-700", label: "Finalized ✓" },
    failed: { color: "bg-red-100 text-red-700", label: "Failed" },
    cancelled: { color: "bg-gray-100 text-ink-slate", label: "Cancelled" },
  };
  const c = cfg[status] || cfg.review;
  return <span className={`text-xs px-2 py-0.5 rounded font-bold ${c.color}`}>{c.label}</span>;
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.95
      ? "bg-emerald-100 text-emerald-700"
      : value >= 0.7
      ? "bg-amber-100 text-amber-700"
      : "bg-red-100 text-red-700";
  return <span className={`text-[11px] px-1.5 py-0.5 rounded ${color} font-bold`}>{pct}%</span>;
}

function RiskBadge({ risk }: { risk: string }) {
  const color =
    risk === "low"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : risk === "medium"
      ? "bg-amber-50 text-amber-700 border-amber-100"
      : "bg-red-50 text-red-700 border-red-100";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${color} font-semibold uppercase tracking-wider`}>
      {risk}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    pending: { color: "bg-amber-100 text-amber-800", label: "Pending" },
    accepted: { color: "bg-emerald-100 text-emerald-700", label: "Accepted" },
    modified: { color: "bg-blue-100 text-blue-700", label: "Modified" },
    rejected: { color: "bg-gray-100 text-ink-slate", label: "Rejected" },
    executed: { color: "bg-emerald-200 text-emerald-900", label: "Executed ✓" },
    failed: { color: "bg-red-100 text-red-700", label: "Failed" },
  };
  const c = cfg[decision] || cfg.pending;
  return <span className={`text-[11px] px-2 py-0.5 rounded font-bold ${c.color}`}>{c.label}</span>;
}

const KIND_LABELS: Record<string, string> = {
  undeposited_funds_clearing: "Undeposited Funds clearing",
  suspense_reclass: "Suspense / Ask My Accountant reclass",
  obe_to_retained_earnings: "Opening Balance Equity → Retained Earnings",
  stale_uncleared_bank_line: "Stale uncleared bank line",
  ar_aging_writeoff: "A/R aging write-off",
  ap_aging_writeoff: "A/P aging write-off",
  negative_balance: "Negative balance investigation",
  inter_account_transfer_dupe: "Duplicate inter-account transfer",
  other: "Other",
};

function IssueCard({
  item,
  runCreatedAt,
  onDecide,
  disabled,
}: {
  item: Item;
  runCreatedAt: string;
  onDecide: (item: Item, decision: string, modifiedFix?: any) => Promise<void>;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLocked = item.decision === "executed" || item.decision === "failed";

  const fix = item.modified_fix || item.proposed_fix;
  const kindLabel = KIND_LABELS[item.kind] || item.kind;

  // Heuristic: an "auto"-accepted item was decided within 60s of the run
  // being created (the analyze endpoint inserts pre-accepted items at the
  // tail of the same request). A manual accept happens minutes/hours later.
  const isAutoAccepted = (() => {
    if (item.decision !== "accepted" || !item.decided_at) return false;
    const gapMs = new Date(item.decided_at).getTime() - new Date(runCreatedAt).getTime();
    return gapMs < 60_000;
  })();

  return (
    <div
      className={`rounded-2xl border bg-white overflow-hidden ${
        item.decision === "executed"
          ? "border-emerald-200 bg-emerald-50/30"
          : item.decision === "failed"
          ? "border-red-200 bg-red-50/30"
          : item.decision === "rejected"
          ? "border-gray-200 bg-gray-50/30 opacity-60"
          : "border-gray-100"
      }`}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-ink-slate flex-shrink-0"
          aria-label="Expand"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-navy">{kindLabel}</span>
            {item.account_name && (
              <span className="text-xs text-ink-slate">· {item.account_name}</span>
            )}
            <DecisionBadge decision={item.decision} />
            {/* Pre-accept transparency: items the AI policy auto-accepted
                surface a small "auto" badge so the bookkeeper knows it wasn't
                their own click. Hides once they re-decide manually. */}
            {isAutoAccepted && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider bg-teal-lighter text-teal px-1.5 py-0.5 rounded"
                title="Auto-accepted by policy (≥95% confidence, low risk, non-tax-sensitive)"
              >
                auto
              </span>
            )}
          </div>
          <div className="text-xs text-ink-slate mt-0.5">{item.description}</div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <RiskBadge risk={item.risk} />
          <ConfidenceBadge value={item.confidence} />
          <span className="font-mono text-sm text-navy tabular-nums whitespace-nowrap">
            ${item.estimated_impact.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-100 pt-3 space-y-3 bg-gray-50/40">
          <div className="text-xs text-ink-slate">
            <strong>AI reasoning:</strong> {item.ai_reasoning}
          </div>

          <FixDetails fix={fix} />

          {item.execution_error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-900">
              <strong>Execution error:</strong> {item.execution_error}
            </div>
          )}
        </div>
      )}

      {!isLocked && (
        <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-2 bg-gray-50/30">
          <button
            onClick={() => onDecide(item, "accepted")}
            disabled={disabled || item.decision === "accepted"}
            className={`inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-semibold disabled:opacity-50 ${
              item.decision === "accepted"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            <Check size={11} />
            {item.decision === "accepted" ? "Accepted" : "Accept"}
          </button>
          <button
            onClick={() => onDecide(item, "rejected")}
            disabled={disabled || item.decision === "rejected"}
            className={`inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-semibold disabled:opacity-50 ${
              item.decision === "rejected"
                ? "bg-gray-200 text-gray-700"
                : "bg-white border border-gray-200 text-ink-slate hover:bg-gray-100"
            }`}
          >
            <X size={11} />
            Reject
          </button>
          <span className="ml-auto text-[11px] text-ink-light italic">
            {item.decided_at ? `decided ${formatAgo(item.decided_at)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function FixDetails({ fix }: { fix: any }) {
  if (!fix) return null;
  if (fix.type === "reclass_lines") {
    return (
      <div className="bg-white rounded border border-gray-100 overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 text-[11px] font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100">
          Reclass {fix.lines.length} line{fix.lines.length === 1 ? "" : "s"}
        </div>
        <table className="w-full text-xs">
          <thead className="bg-gray-50/50">
            <tr className="text-left text-ink-slate">
              <th className="px-2 py-1 font-semibold">Tx ID</th>
              <th className="px-2 py-1 font-semibold">Type</th>
              <th className="px-2 py-1 font-semibold text-right">Amount</th>
              <th className="px-2 py-1 font-semibold">→ Target account</th>
            </tr>
          </thead>
          <tbody>
            {fix.lines.map((ln: any, i: number) => (
              <tr key={i} className="border-t border-gray-50">
                <td className="px-2 py-1 font-mono text-[10px]">{ln.qbo_transaction_id}</td>
                <td className="px-2 py-1 text-ink-slate">{ln.qbo_transaction_type}</td>
                <td className="px-2 py-1 text-right font-mono">
                  ${Math.abs(Number(ln.amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td className="px-2 py-1 text-navy">{ln.new_account_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (fix.type === "journal_entry") {
    const je = fix.je;
    const debits = (je.lines || []).filter((l: any) => l.posting_type === "Debit");
    const credits = (je.lines || []).filter((l: any) => l.posting_type === "Credit");
    return (
      <div className="bg-white rounded border border-gray-100 overflow-hidden">
        <div className="px-3 py-2 bg-gray-50 text-[11px] font-bold uppercase tracking-wider text-ink-slate border-b border-gray-100 flex items-center justify-between">
          <span>Journal entry · {je.txn_date}</span>
          <span className="text-ink-light italic font-normal normal-case tracking-normal">{je.private_note}</span>
        </div>
        <table className="w-full text-xs">
          <thead className="bg-gray-50/50">
            <tr className="text-left text-ink-slate">
              <th className="px-2 py-1 font-semibold">Account</th>
              <th className="px-2 py-1 font-semibold text-right">Debit</th>
              <th className="px-2 py-1 font-semibold text-right">Credit</th>
              <th className="px-2 py-1 font-semibold">Memo</th>
            </tr>
          </thead>
          <tbody>
            {(je.lines || []).map((l: any, i: number) => (
              <tr key={i} className="border-t border-gray-50">
                <td className="px-2 py-1 text-navy font-semibold">{l.account_name}</td>
                <td className="px-2 py-1 text-right font-mono">
                  {l.posting_type === "Debit"
                    ? `$${Number(l.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                    : ""}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {l.posting_type === "Credit"
                    ? `$${Number(l.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                    : ""}
                </td>
                <td className="px-2 py-1 text-ink-slate">{l.description}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 bg-gray-50">
              <td className="px-2 py-1 text-[10px] font-bold text-ink-slate text-right">Totals:</td>
              <td className="px-2 py-1 text-right font-mono font-bold">
                ${debits.reduce((s: number, l: any) => s + Number(l.amount), 0).toFixed(2)}
              </td>
              <td className="px-2 py-1 text-right font-mono font-bold">
                ${credits.reduce((s: number, l: any) => s + Number(l.amount), 0).toFixed(2)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  if (fix.type === "flag_for_manual") {
    return (
      <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <strong>Manual investigation needed:</strong>
            <div className="mt-1">{fix.notes}</div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function FinalizedRunSummary({ run, items }: { run: Run; items: Item[] }) {
  const exec = items.filter((i) => i.decision === "executed").length;
  const failed = items.filter((i) => i.decision === "failed").length;
  const totalExecutedImpact = items
    .filter((i) => i.decision === "executed")
    .reduce((s, i) => s + i.estimated_impact, 0);

  // Pull clientLinkId from URL — the summary card lives in a couple of places
  const clientLinkId =
    typeof window !== "undefined"
      ? window.location.pathname.split("/")[2] || ""
      : "";

  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="text-emerald-700 flex-shrink-0 mt-0.5" size={22} />
        <div className="flex-1">
          <h3 className="font-bold text-emerald-900 text-base">
            Cleanup complete · {exec} {exec === 1 ? "fix" : "fixes"} pushed to QBO
          </h3>
          <p className="text-sm text-emerald-800 mt-1">
            Finalized {formatAgo(run.finalized_at || run.created_at)}.{" "}
            {totalExecutedImpact > 0 && (
              <>
                Total $ impact: ${totalExecutedImpact.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.{" "}
              </>
            )}
            {failed > 0 && (
              <span className="text-red-700">
                {failed} {failed === 1 ? "fix" : "fixes"} failed — see per-item errors below.
              </span>
            )}
          </p>
        </div>
      </div>
      {clientLinkId && (
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/balance-sheet/${clientLinkId}/coa`}
            className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <ArrowLeft size={13} />
            Back to BS COA viewer
          </Link>
          <Link
            href={`/balance-sheet/${clientLinkId}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-900 hover:text-emerald-700 px-3 py-2"
          >
            Continue to BS workflow
            <ArrowRight size={13} />
          </Link>
        </div>
      )}
    </div>
  );
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
