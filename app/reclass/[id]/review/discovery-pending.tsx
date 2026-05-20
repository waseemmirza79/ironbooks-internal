"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, AlertCircle, CheckCircle2, Sparkles, Database, RotateCcw, XCircle } from "lucide-react";

export function ReclassDiscoveryPending({
  jobId,
  clientLinkId,
  workflow,
}: {
  jobId: string;
  clientLinkId?: string;
  workflow?: string;
}) {
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState<number>(0);
  const [cancelling, setCancelling] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/reclass/${jobId}/status`);
        if (!res.ok) throw new Error("Status check failed");
        const data = await res.json();
        if (cancelled) return;

        setStats(data.stats);
        if (data.ai_progress) setAiProgress(data.ai_progress);
        if (data.phase !== undefined) setPhase(data.phase);

        if (data.status === "in_review") {
          window.location.reload();
          return;
        }
        if (data.status === "failed") {
          setError(data.error_message || "Discovery failed");
          return;
        }
        if (data.status === "complete") {
          window.location.href = `/reclass/${jobId}/execute`;
          return;
        }

        setTimeout(poll, 2000);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    poll();
    return () => { cancelled = true; };
  }, [jobId, router]);

  async function cancelJob() {
    if (!confirm("Cancel this job? It will be marked as failed and you can start a new one.")) return;
    setCancelling(true);
    try {
      await fetch(`/api/reclass/${jobId}/cancel`, { method: "POST" });
      window.location.reload();
    } catch {
      setCancelling(false);
    }
  }

  if (error) {
    // Build a retry URL — drops the bookkeeper into the new-reclass form
    // pre-selected on this client. They pick the source account + dates
    // again (the failed job's source/dates aren't known to be safe to
    // reuse without confirmation, and re-picking takes <10 seconds).
    const retryHref = clientLinkId
      ? `/reclass/new?client=${clientLinkId}${
          workflow ? `&workflow=${encodeURIComponent(workflow)}` : ""
        }`
      : "/reclass/new";

    const isWatchdogFailure = /watchdog/i.test(error);

    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 space-y-5">
        <div className="flex items-start gap-3 p-4 bg-red-50 text-red-800 rounded-lg">
          <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
          <div>
            <div className="font-semibold mb-1">Discovery failed</div>
            <div className="text-sm">{error}</div>
            {isWatchdogFailure && (
              <div className="text-xs mt-2 text-red-700/80 leading-relaxed">
                Most often a transient Anthropic / web-search hang. Starting a
                fresh reclass usually succeeds — the AI batches and per-vendor
                web search both have explicit timeouts now, so a single stalled
                call won&apos;t block the whole job again.
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={retryHref}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            <RotateCcw size={14} />
            Start a fresh reclass for this client
          </Link>
          <Link
            href="/dashboard"
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Back to dashboard
          </Link>
          <a
            href={`/api/jobs/${jobId}/error-report`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold text-ink-slate hover:text-navy underline ml-auto"
            title="Markdown error report — share with engineering if this keeps happening"
          >
            Download error report
          </a>
        </div>
      </div>
    );
  }

  // Stage detection driven by server-side phase markers (more reliable than
  // elapsed time). Falls back to time-based guess only when no phase yet.
  function stageFromPhase(p: string | null): "pulling" | "knowledge_base" | "ai" | "saving" {
    if (!p) return aiProgress ? "ai" : elapsed < 5 ? "pulling" : "knowledge_base";
    if (p.startsWith("pulling")) return "pulling";
    if (p.startsWith("fetching_accounts") || p.startsWith("pre_matching")) return "knowledge_base";
    if (p.startsWith("running_ai")) return "ai";
    if (p.startsWith("saving")) return "saving";
    return aiProgress ? "ai" : "knowledge_base";
  }
  const stage = stageFromPhase(phase);

  // Friendly label for the current phase shown under the active step.
  function phaseLabel(p: string | null): string {
    if (!p) return "Starting…";
    if (p.startsWith("pulling")) return "Pulling transactions from QuickBooks";
    if (p === "fetching_accounts") return "Fetching chart of accounts";
    if (p === "pre_matching") return "Matching against knowledge base + bank rules";
    if (p.startsWith("running_ai")) return `Running AI categorization — ${p.replace("running_ai", "").trim() || "starting"}`;
    if (p.startsWith("saving")) return `Saving results — ${p.replace("saving", "").trim() || ""}`;
    return p;
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8">
      <div className="flex items-center gap-3 mb-2">
        <Loader2 className="animate-spin text-teal" size={24} />
        <h2 className="text-lg font-bold text-navy">Discovery in progress</h2>
        <span className="text-xs font-mono text-ink-slate">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
        <button
          onClick={cancelJob}
          disabled={cancelling}
          className="ml-auto flex items-center gap-1 text-xs text-ink-slate hover:text-red-600 disabled:opacity-50"
          title="Cancel this job and start a fresh one"
        >
          {cancelling ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={13} />}
          {cancelling ? "Cancelling…" : "Cancel job"}
        </button>
      </div>
      <div className="mb-6 p-3 rounded-lg bg-teal-lighter/50 border border-teal/20 flex items-center gap-2">
        <Loader2 className="animate-spin text-teal flex-shrink-0" size={14} />
        <span className="text-sm font-semibold text-navy">{phaseLabel(phase)}</span>
        {aiProgress && (
          <span className="text-xs text-ink-slate ml-auto">
            Batch {aiProgress.done} / {aiProgress.total}
          </span>
        )}
      </div>

      {/* Pipeline stages */}
      <div className="rounded-xl bg-gray-50 p-4 mb-5 border border-gray-100">

        {/* Row 1 */}
        <div className="flex items-start gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage !== "pulling" ? "#D1FAE5" : "#E8F2F0" }}>
            {stage !== "pulling"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : <Loader2 size={14} className="text-teal animate-spin" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage !== "pulling" ? "text-green-700" : "text-navy"}`}>
              1. Pull transactions from QuickBooks
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Fetching all lines in the selected date range</div>
          </div>
        </div>

        {/* Row 2 */}
        <div className="flex items-start gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage === "ai" || stage === "saving" ? "#D1FAE5" : stage === "knowledge_base" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "ai" || stage === "saving"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "knowledge_base"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Database size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "ai" || stage === "saving" ? "text-green-700" : stage === "knowledge_base" ? "text-navy" : "text-ink-light"}`}>
              2. Knowledge base + bank rules pre-match
            </div>
            <div className="text-xs text-ink-slate mt-0.5">Instant matches for ~200 known vendors + your prior categorizations</div>
          </div>
        </div>

        {/* Row 3 */}
        <div className="flex items-center gap-3 py-2.5">
          <div className="rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: stage === "saving" ? "#D1FAE5" : stage === "ai" ? "#E8F2F0" : "#F3F4F6" }}>
            {stage === "saving"
              ? <CheckCircle2 size={16} className="text-green-600" />
              : stage === "ai"
              ? <Loader2 size={14} className="text-teal animate-spin" />
              : <Sparkles size={14} className="text-ink-light" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${stage === "saving" ? "text-green-700" : stage === "ai" ? "text-navy" : "text-ink-light"}`}>
              3. AI categorization (Claude)
            </div>
            <div className="text-xs text-ink-slate mt-0.5">
              {aiProgress
                ? `Batch ${aiProgress.done} of ${aiProgress.total} complete`
                : "Sequential batches — ~15 lines per call, ~10–60s each"}
            </div>
          </div>
        </div>

      </div>

      {/* Progress bar driven by aiProgress */}
      {aiProgress && aiProgress.total > 0 && (
        <div className="mb-5">
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className="bg-teal h-2 rounded-full transition-all"
              style={{ width: `${Math.round((aiProgress.done / aiProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-2 text-sm">
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Transactions pulled</span>
          <span className="font-semibold text-navy">{stats?.pulled || "..."}</span>
        </div>
        <div className="flex justify-between py-2 border-b border-gray-100">
          <span className="text-ink-slate">Skipped (reconciled)</span>
          <span className="font-semibold text-navy">{stats?.skipped_reconciled || 0}</span>
        </div>
        <div className="flex justify-between py-2">
          <span className="text-ink-slate">Skipped (closed period)</span>
          <span className="font-semibold text-navy">{stats?.skipped_closed || 0}</span>
        </div>
      </div>

      <p className="text-xs text-ink-light text-center mt-5">
        Page auto-refreshes when discovery completes. If anything goes wrong, click Cancel job
        and start a fresh one.
      </p>
    </div>
  );
}
