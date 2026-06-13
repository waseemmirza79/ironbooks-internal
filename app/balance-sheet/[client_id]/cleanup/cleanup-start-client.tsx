"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowRight, Calendar, Plug, XCircle } from "lucide-react";

type QboStatus = "connected" | "token_expired" | "never_connected";

export function CleanupStartClient({
  clientLinkId,
  clientName,
  qboStatus,
}: {
  clientLinkId: string;
  clientName: string;
  qboStatus: QboStatus;
}) {
  const router = useRouter();
  // Default the lock to Jan 1 of the current year — "clean up this year,
  // don't touch prior-year books" is the standard starting posture.
  const [periodLockDate, setPeriodLockDate] = useState(
    `${new Date().getFullYear()}-01-01`
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [reconnectUrl, setReconnectUrl] = useState<string | null>(null);

  const needsQbo = qboStatus !== "connected";
  const reconnectHref = `/api/qbo/connect?client_link_id=${encodeURIComponent(clientLinkId)}`;

  async function startRun() {
    setStarting(true);
    setError("");
    setReconnectUrl(null);
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
      if (!res.ok) {
        if (data.error === "qbo_reauth_required") {
          setReconnectUrl(data.reconnect_url || reconnectHref);
          setError(
            data.message ||
              "QuickBooks needs to be reconnected before this cleanup can start."
          );
          return;
        }
        throw new Error(data.error || "Failed to start");
      }
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

      {needsQbo && (
        <div
          className={`mb-6 rounded-xl border-2 p-4 ${
            qboStatus === "never_connected"
              ? "border-amber-300 bg-amber-50"
              : "border-red-300 bg-red-50"
          }`}
        >
          <div className="flex items-start gap-3">
            {qboStatus === "never_connected" ? (
              <Plug size={20} className="text-amber-700 mt-0.5 flex-shrink-0" />
            ) : (
              <XCircle size={20} className="text-red-700 mt-0.5 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm text-navy">
                {qboStatus === "never_connected"
                  ? "QuickBooks not connected"
                  : "QuickBooks connection expired"}
              </div>
              <p className="text-xs mt-1 leading-relaxed text-ink-slate">
                {qboStatus === "never_connected"
                  ? "Connect QuickBooks before starting BS cleanup."
                  : "SNAP cannot refresh the QBO token for this client. Reconnect QuickBooks, then come back and start again."}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  href={reconnectHref}
                  className={`inline-flex items-center gap-2 text-sm font-bold rounded-lg px-4 py-2 text-white ${
                    qboStatus === "never_connected"
                      ? "bg-teal hover:bg-teal-dark"
                      : "bg-red-600 hover:bg-red-700"
                  }`}
                >
                  {qboStatus === "never_connected"
                    ? "Connect QuickBooks"
                    : "Reconnect QuickBooks"}
                  <ArrowRight size={14} />
                </a>
                <Link
                  href={`/clients/${clientLinkId}`}
                  className="text-xs font-semibold text-ink-slate hover:underline"
                >
                  Client profile → QuickBooks
                </Link>
              </div>
              <p className="text-[11px] text-ink-light mt-3">
                Use <strong>ironbooks.com</strong> for reconnect — QBO OAuth is registered
                to production, not Vercel preview URLs.
              </p>
            </div>
          </div>
        </div>
      )}

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
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm space-y-3">
          <p>{error}</p>
          {reconnectUrl && (
            <a
              href={reconnectUrl}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-lg px-4 py-2"
            >
              Reconnect QuickBooks <ArrowRight size={14} />
            </a>
          )}
        </div>
      )}

      <button
        onClick={startRun}
        disabled={starting || !periodLockDate || needsQbo}
        className="w-full flex items-center justify-center gap-2 bg-teal hover:bg-teal-dark text-white font-semibold py-3 px-4 rounded-xl transition-colors disabled:opacity-50"
      >
        {starting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <>
            {needsQbo ? "Connect QuickBooks first" : "Connect & Diagnose"}
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
