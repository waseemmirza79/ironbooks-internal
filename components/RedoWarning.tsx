"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Warns (never blocks) when the selected client has already been cleaned up or
 * already has a completed job of this type — the start button stays disabled
 * until the user ticks the explicit override. Fetches load-time from
 * /api/clients/[id]/redo-status so deep-links are covered. Reports the allowed
 * state up via onAllowChange so the parent form can gate its submit.
 */
export function RedoWarning({
  clientId,
  kind,
  onAllowChange,
}: {
  clientId: string | null | undefined;
  kind: "coa" | "reclass" | "rules";
  onAllowChange?: (allowed: boolean) => void;
}) {
  const [status, setStatus] = useState<{
    alreadyCleanedUp: boolean;
    cleanupCompletedAt: string | null;
    hasCompletedJobOfType: boolean;
    lastCompletedAt: string | null;
  } | null>(null);
  const [override, setOverride] = useState(false);

  useEffect(() => {
    setStatus(null);
    setOverride(false);
    if (!clientId) {
      onAllowChange?.(true);
      return;
    }
    let cancelled = false;
    fetch(`/api/clients/${clientId}/redo-status?kind=${kind}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, kind]);

  const flagged = !!status && (status.alreadyCleanedUp || status.hasCompletedJobOfType);

  useEffect(() => {
    onAllowChange?.(!flagged || override);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagged, override]);

  if (!flagged || !status) return null;
  const date = status.cleanupCompletedAt || status.lastCompletedAt;
  const dateStr = date ? ` on ${new Date(date).toLocaleDateString()}` : "";

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="flex items-center gap-2 font-semibold text-amber-900">
        <AlertTriangle size={15} />
        {status.alreadyCleanedUp
          ? "This company was already cleaned up"
          : "This step was already completed"}
      </div>
      <p className="text-amber-800 mt-1 text-[13px] leading-snug">
        {status.alreadyCleanedUp
          ? `Cleanup was signed off${dateStr}. Redoing it starts fresh and re-posts to QuickBooks.`
          : `A ${kind} job already finished${dateStr}. Running another creates a brand-new job.`}
      </p>
      <label className="flex items-center gap-2 mt-2 text-[13px] font-semibold text-amber-900 cursor-pointer">
        <input
          type="checkbox"
          checked={override}
          onChange={(e) => setOverride(e.target.checked)}
          className="w-4 h-4 rounded border-amber-400"
        />
        I understand — redo from scratch
      </label>
    </div>
  );
}
