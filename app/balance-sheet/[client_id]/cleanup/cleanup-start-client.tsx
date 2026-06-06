"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowRight, Calendar, Upload } from "lucide-react";

export function CleanupStartClient({
  clientLinkId,
  clientName,
}: {
  clientLinkId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [periodLockDate, setPeriodLockDate] = useState(
    new Date(new Date().getFullYear(), new Date().getMonth(), 0)
      .toISOString()
      .slice(0, 10)
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  async function startRun() {
    setStarting(true);
    setError("");
    try {
      const res = await fetch("/api/cleanup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          period_lock_date: periodLockDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");
      router.push(`/balance-sheet/${clientLinkId}/cleanup/${data.run_id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8">
      <h2 className="text-xl font-bold text-navy mb-2">Start Balance Sheet Cleanup</h2>
      <p className="text-sm text-ink-light mb-6">
        {clientName} — connect your QBO data, set the period lock, and run the guided
        cleanup pipeline. Nothing posts to QuickBooks without your approval.
      </p>

      <div className="space-y-4 mb-6">
        <label className="block">
          <span className="text-sm font-semibold text-navy flex items-center gap-2 mb-1.5">
            <Calendar size={14} />
            Period lock date
          </span>
          <input
            type="date"
            value={periodLockDate}
            onChange={(e) => setPeriodLockDate(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
          <span className="text-xs text-ink-light mt-1 block">
            Transactions on or before this date will not be edited directly.
          </span>
        </label>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
      )}

      <button
        onClick={startRun}
        disabled={starting || !periodLockDate}
        className="w-full flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold py-3 px-4 rounded-xl transition-colors disabled:opacity-50"
      >
        {starting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <>
            Connect &amp; Diagnose
            <ArrowRight size={16} />
          </>
        )}
      </button>

      <p className="text-xs text-ink-light mt-4 text-center">
        You can upload bank and processor CSVs after the Health Score loads.
      </p>
    </div>
  );
}
