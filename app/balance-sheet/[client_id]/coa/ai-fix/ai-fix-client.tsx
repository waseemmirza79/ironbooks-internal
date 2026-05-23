"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Sparkles, Loader2, AlertTriangle, CheckCircle2, X, RefreshCw,
  ChevronDown, ChevronRight, Send, Check, Edit2, AlertCircle,
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
    } catch (e: any) {
      setError(e?.message || "Finalize failed");
    } finally {
      setFinalizing(false);
    }
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
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center space-y-3">
        <Loader2 className="animate-spin text-teal mx-auto" size={36} />
        <div className="font-semibold text-navy">Analyzing Balance Sheet…</div>
        <p className="text-sm text-ink-slate max-w-md mx-auto">
          Pulling every BS account + recent transactions on suspect ones, then asking Claude
          to identify cleanup issues. Typically 10-30 seconds.
        </p>
      </div>
    );
  }

  // ── STAGE 2 + 3: review + finalize ──
  if (!run) return null;
  const acceptedCount = items.filter((i) =>
    ["accepted", "modified"].includes(i.decision)
  ).length;
  const totalAcceptedImpact = items
    .filter((i) => ["accepted", "modified"].includes(i.decision))
    .reduce((s, i) => s + i.estimated_impact, 0);

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

      {/* Issues list */}
      {items.length === 0 ? (
        <div className="p-8 bg-white rounded-2xl border border-gray-100 text-center text-sm text-ink-slate">
          {loading ? <Loader2 className="animate-spin mx-auto text-teal" size={20} /> : "No issues found — books look clean."}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <IssueCard key={item.id} item={item} onDecide={decide} disabled={finalizing} />
          ))}
        </div>
      )}

      {/* Finalize bar */}
      {items.length > 0 && run.status !== "finalized" && (
        <div className="sticky bottom-0 bg-white border-2 border-teal rounded-2xl p-4 shadow-lg flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="font-bold text-navy">
              Ready to finalize {acceptedCount} {acceptedCount === 1 ? "fix" : "fixes"}
            </div>
            <div className="text-xs text-ink-slate">
              Total $ impact: ${totalAcceptedImpact.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <button
            onClick={finalize}
            disabled={finalizing || acceptedCount === 0}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg disabled:opacity-50"
          >
            {finalizing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Finalize · push to QBO
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
  onDecide,
  disabled,
}: {
  item: Item;
  onDecide: (item: Item, decision: string, modifiedFix?: any) => Promise<void>;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLocked = item.decision === "executed" || item.decision === "failed";

  const fix = item.modified_fix || item.proposed_fix;
  const kindLabel = KIND_LABELS[item.kind] || item.kind;

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
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="text-emerald-700 flex-shrink-0 mt-0.5" size={20} />
        <div className="flex-1">
          <h3 className="font-bold text-emerald-900">
            Run finalized {formatAgo(run.finalized_at || run.created_at)}
          </h3>
          <p className="text-sm text-emerald-800 mt-1">
            {exec} {exec === 1 ? "fix" : "fixes"} pushed to QBO
            {failed > 0 && `, ${failed} failed (see per-item errors above)`}.
          </p>
        </div>
      </div>
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
