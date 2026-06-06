"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Send, Sparkles, Package, AlertTriangle, CheckCircle2, Loader2, RefreshCw, CheckCheck,
} from "lucide-react";
import type { FleetReadinessSummary, ClientReadiness } from "@/lib/month-end/types";

interface Props {
  initialYear: number;
  initialMonth: number;
  actorName: string;
}

export function MonthEndClient({ initialYear, initialMonth }: Props) {
  const [periodYear, setPeriodYear] = useState(initialYear);
  const [periodMonth, setPeriodMonth] = useState(initialMonth);
  const [fleet, setFleet] = useState<FleetReadinessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<ClientReadiness | null>(null);
  const [editSummary, setEditSummary] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);

  const periodBody = { period_year: periodYear, period_month: periodMonth };

  const loadFleet = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/month-end/readiness?period_year=${periodYear}&period_month=${periodMonth}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setFleet(data);
    } catch (err: any) {
      setError(err?.message || "Failed to load fleet readiness");
    } finally {
      setLoading(false);
    }
  }, [periodYear, periodMonth]);

  useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  async function runAction(
    label: string,
    url: string,
    body: Record<string, unknown> = {}
  ) {
    setBusy(label);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...periodBody, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);

      if (label === "send") {
        setMessage(`Sent ${data.sent}, skipped ${data.skipped || 0}, failed ${data.failed}`);
        setConfirmSend(false);
      } else if (label === "generate") {
        setMessage(
          `Generated ${data.generated}, failed ${data.failed}` +
            (data.remaining ? ` — ${data.remaining} remaining, run again` : "")
        );
      } else if (label === "approve") {
        setMessage(`Approved ${data.approved}, failed ${data.failed}`);
      } else {
        setMessage(`Built ${data.built}, failed ${data.failed}`);
      }
      await loadFleet();
    } catch (err: any) {
      setError(err?.message || `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function openSummaryEditor(client: ClientReadiness) {
    if (!client.packageId) return;
    setSelectedClient(client);
    setEditSummary("");
    try {
      const res = await fetch(`/api/month-end/packages/${client.packageId}`);
      const pkg = await res.json();
      if (!res.ok) throw new Error(pkg.error || "Failed to load");
      setEditSummary(pkg.ai_summary || "");
    } catch (err: any) {
      setError(err?.message || "Could not load package");
    }
  }

  async function saveReviewed() {
    if (!selectedClient?.packageId) return;
    setBusy("review");
    setError(null);
    try {
      const res = await fetch(`/api/month-end/packages/${selectedClient.packageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_summary: editSummary.trim(),
          ai_summary_reviewed: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setMessage(`${selectedClient.clientName}: summary approved`);
      setSelectedClient(null);
      await loadFleet();
    } catch (err: any) {
      setError(err?.message || "Save failed");
    } finally {
      setBusy(null);
    }
  }

  const periodLabel = fleet?.period.label || `${periodMonth}/${periodYear}`;
  const inProgress = fleet
    ? [
        ...fleet.ready,
        ...fleet.blocked.filter((c) => c.packageId && c.operationallyReady),
      ]
    : [];

  const draftWithSummary = fleet
    ? fleet.blocked
        .concat(fleet.ready)
        .filter(
          (c) =>
            c.operationallyReady &&
            c.packageStatus === "draft" &&
            c.blockReasons.includes("summary_not_reviewed")
        ).length
    : 0;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Month-End Delivery</h1>
          <p className="text-sm text-ink-slate mt-1">
            {periodLabel} — frozen snapshots, reviewed summaries, then deliver.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-ink-slate">Period</label>
          <input
            type="number"
            className="w-20 border rounded px-2 py-1 text-sm"
            value={periodMonth}
            min={1}
            max={12}
            onChange={(e) => setPeriodMonth(Number(e.target.value))}
          />
          <input
            type="number"
            className="w-24 border rounded px-2 py-1 text-sm"
            value={periodYear}
            onChange={(e) => setPeriodYear(Number(e.target.value))}
          />
          <button
            onClick={loadFleet}
            className="p-2 rounded border hover:bg-gray-50"
            title="Refresh"
            disabled={!!busy}
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-800">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-ink-slate">
          <Loader2 className="animate-spin" size={18} /> Loading fleet…
        </div>
      )}

      {fleet && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Ready to send" value={fleet.counts.ready} tone="green" />
            <StatCard label="Blocked" value={fleet.counts.blocked} tone="amber" />
            <StatCard label="Already sent" value={fleet.counts.sent} tone="teal" />
            <StatCard label="Failed" value={fleet.counts.failed} tone="red" />
          </div>

          <div className="flex flex-wrap gap-3">
            <ActionButton
              icon={Package}
              label="Build packages"
              busy={busy === "build"}
              disabled={!!busy}
              onClick={() => runAction("build", "/api/month-end/packages", { build_all_ready: true })}
            />
            <ActionButton
              icon={Sparkles}
              label="Generate summaries"
              busy={busy === "generate"}
              disabled={!!busy}
              onClick={() =>
                runAction("generate", "/api/month-end/generate-summaries", {
                  generate_all_drafts: true,
                })
              }
            />
            <ActionButton
              icon={CheckCheck}
              label={`Bulk approve (${draftWithSummary})`}
              busy={busy === "approve"}
              disabled={!!busy || draftWithSummary === 0}
              onClick={() =>
                runAction("approve", "/api/month-end/bulk-approve", {
                  approve_all_with_summary: true,
                })
              }
            />
            <ActionButton
              icon={Send}
              label={`Send ready (${fleet.counts.ready})`}
              busy={busy === "send"}
              disabled={!!busy || fleet.counts.ready === 0}
              onClick={() => setConfirmSend(true)}
              primary
            />
          </div>

          {message && (
            <div className="text-sm bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-emerald-900">
              {message}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            <ClientList
              title={`Blocked (${fleet.blocked.length})`}
              clients={fleet.blocked}
              tone="blocked"
              onSelect={openSummaryEditor}
            />
            <ClientList
              title={`Ready / in progress (${inProgress.length})`}
              clients={inProgress}
              tone="ready"
              onSelect={openSummaryEditor}
            />
          </div>
        </>
      )}

      {confirmSend && fleet && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-bold text-navy">Confirm bulk send</h3>
            <p className="text-sm text-ink-slate">
              Send {fleet.counts.ready} client{fleet.counts.ready === 1 ? "" : "s"} their{" "}
              <strong>{periodLabel}</strong> statements? This publishes the portal and sends email.
              Already-sent clients are skipped automatically.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 text-sm rounded border"
                onClick={() => setConfirmSend(false)}
                disabled={busy === "send"}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm rounded bg-navy text-white font-semibold disabled:opacity-50"
                disabled={busy === "send"}
                onClick={() => runAction("send", "/api/month-end/send", { send_all_ready: true })}
              >
                {busy === "send" ? "Sending…" : "Send now"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedClient && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <h3 className="font-bold text-navy">Review — {selectedClient.clientName}</h3>
            <p className="text-xs text-ink-slate">
              Minimum 80 characters. Edit if needed, then approve before sending.
            </p>
            <textarea
              className="w-full h-48 border rounded-lg p-3 text-sm font-mono leading-relaxed"
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
              placeholder="Generate summaries first…"
            />
            <div className="text-xs text-ink-light">{editSummary.trim().length} characters</div>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 text-sm rounded border"
                onClick={() => setSelectedClient(null)}
                disabled={busy === "review"}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 text-sm rounded bg-teal text-white font-semibold disabled:opacity-50"
                disabled={busy === "review" || editSummary.trim().length < 80}
                onClick={saveReviewed}
              >
                Approve summary
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "green" | "amber" | "teal" | "red";
}) {
  const colors = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    teal: "border-teal-200 bg-teal-50 text-teal-900",
    red: "border-red-200 bg-red-50 text-red-800",
  };
  return (
    <div className={`rounded-xl border-2 p-4 ${colors[tone]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  busy,
  disabled,
  primary,
}: {
  icon: typeof Send;
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 ${
        primary
          ? "bg-navy text-white hover:bg-navy/90"
          : "border border-gray-200 hover:bg-gray-50 text-navy"
      }`}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
      {label}
    </button>
  );
}

function ClientList({
  title,
  clients,
  tone,
  onSelect,
}: {
  title: string;
  clients: ClientReadiness[];
  tone: "blocked" | "ready";
  onSelect: (c: ClientReadiness) => void;
}) {
  const Icon = tone === "blocked" ? AlertTriangle : CheckCircle2;
  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b font-semibold text-sm text-navy flex items-center gap-2">
        <Icon size={16} className={tone === "blocked" ? "text-amber-600" : "text-emerald-600"} />
        {title}
      </div>
      <ul className="divide-y max-h-96 overflow-y-auto">
        {clients.length === 0 && (
          <li className="px-4 py-6 text-sm text-ink-slate text-center">None</li>
        )}
        {clients.map((c) => (
          <li key={c.clientLinkId}>
            <button
              type="button"
              onClick={() => onSelect(c)}
              disabled={!c.packageId}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-navy text-sm">{c.clientName}</div>
              {c.blockLabels.length > 0 && (
                <div className="text-xs text-ink-slate mt-0.5">{c.blockLabels.join(" · ")}</div>
              )}
              {c.packageStatus && (
                <div className="text-xs text-teal-dark mt-0.5 capitalize">
                  Package: {c.packageStatus.replace(/_/g, " ")}
                  {c.aiSummaryReviewed ? " · summary ✓" : ""}
                  {c.todayPendingCount > 0 ? ` · ${c.todayPendingCount} Today pending` : ""}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
