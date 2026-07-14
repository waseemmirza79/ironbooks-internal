"use client";

import { useState } from "react";
import { Loader2, Play, CheckCircle2, ShieldCheck } from "lucide-react";

interface Summary {
  scanned: number; executed: number; left_for_review: number;
  skipped_closed: number; skipped_stale: number; failed: number; remaining: number;
}

export function DrainClient({ pendingCount }: { pendingCount: number }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [totals, setTotals] = useState<Summary | null>(null);
  const [passMsg, setPassMsg] = useState("");

  async function drain() {
    if (!confirm(
      `Drain the pending review queue (${pendingCount} items) through the reviewed vendor rules?\n\n` +
      `Confident matches (≥0.90, under each client's auto-approve threshold) POST TO QUICKBOOKS. ` +
      `Closed periods, moved lines, and anything uncertain stay in the queue for humans.`
    )) return;
    setRunning(true); setError(""); setTotals(null);
    const acc: Summary = { scanned: 0, executed: 0, left_for_review: 0, skipped_closed: 0, skipped_stale: 0, failed: 0, remaining: 0 };
    try {
      for (let pass = 1; pass <= 20; pass++) {
        setPassMsg(`pass ${pass} running…`);
        const res = await fetch("/api/admin/daily-queue/drain", { method: "POST" });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        acc.scanned += d.scanned; acc.executed += d.executed; acc.left_for_review += d.left_for_review;
        acc.skipped_closed += d.skipped_closed; acc.skipped_stale += d.skipped_stale; acc.failed += d.failed;
        acc.remaining = d.remaining;
        setTotals({ ...acc });
        if (!d.remaining) break;
      }
      setPassMsg("");
    } catch (e: any) { setError(e.message); }
    setRunning(false);
  }

  return (
    <div className="space-y-4">
      <div className="p-4 bg-blue-50 rounded-xl text-sm text-blue-900">
        <strong>{pendingCount.toLocaleString()} items</strong> are waiting for review. Most were queued by the
        old 0.95 confidence floor — rules Mike/Lisa already reviewed sit at 0.90, so those items can post
        automatically. This runs each pending item through the current rules with the standard protections
        (closed periods untouched, lines someone already moved are kept, per-client dollar threshold).
      </div>
      <button
        onClick={drain}
        disabled={running || pendingCount === 0}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal text-white text-sm font-semibold hover:bg-teal-dark disabled:opacity-50"
      >
        {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        Drain backlog through reviewed rules
      </button>
      {passMsg && <span className="text-xs text-ink-slate ml-2">{passMsg}</span>}
      {error && <div className="text-sm font-semibold text-red-600">{error}</div>}
      {totals && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-1.5 text-sm">
          <div className="flex items-center gap-2 font-semibold text-navy mb-2">
            {totals.remaining ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} className="text-emerald-600" />}
            {totals.remaining ? "In progress…" : "Drain complete"}
          </div>
          <div className="flex justify-between"><span className="text-ink-slate">Auto-posted to QuickBooks</span><span className="font-semibold text-emerald-700">{totals.executed}</span></div>
          <div className="flex justify-between"><span className="text-ink-slate">Left for human review</span><span className="font-semibold text-navy">{totals.left_for_review}</span></div>
          {totals.skipped_closed > 0 && <div className="flex justify-between"><span className="text-ink-slate">Skipped — closed period</span><span className="font-semibold">{totals.skipped_closed}</span></div>}
          {totals.skipped_stale > 0 && <div className="flex justify-between"><span className="text-ink-slate">Kept — already moved by a human</span><span className="font-semibold">{totals.skipped_stale}</span></div>}
          {totals.failed > 0 && <div className="flex justify-between text-red-600"><span>Failed</span><span className="font-semibold">{totals.failed}</span></div>}
        </div>
      )}
      <div className="flex items-start gap-2 text-xs text-ink-slate">
        <CheckCircle2 size={13} className="mt-0.5 flex-shrink-0" />
        <span>Going forward the nightly run auto-posts at the same 0.90 floor, so the queue only receives genuine unknowns.</span>
      </div>
    </div>
  );
}
