"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ClipboardCheck, ArrowRight, Loader2, Activity } from "lucide-react";

type QboStatus = "connected" | "dead" | "not_connected";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  cleanup_completed_at: string | null;
  qbo_status: QboStatus;
}

interface ActiveRun {
  client_link_id: string;
  id: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  discovering: "Discovering",
  reviewing: "In review",
  executing: "Executing",
};

/**
 * Per-row QBO indicator. Three states map to one of three dot colors
 * + a tooltip that explains what they actually mean in plain English.
 *
 * Behavior intentionally conservative — we only mark RED when we have
 * positive evidence the token is dead (most-recent probe says so). If
 * the probe is stale or hasn't run, healthy tokens win the tie.
 */
function QboStatusDot({
  status,
  probeAgeHours,
}: {
  status: QboStatus;
  probeAgeHours: number | null;
}) {
  const probeNote =
    probeAgeHours == null
      ? "No recent connection check has run."
      : probeAgeHours < 1
      ? `Last connection check: ${Math.round(probeAgeHours * 60)}m ago`
      : probeAgeHours < 24
      ? `Last connection check: ${Math.round(probeAgeHours)}h ago`
      : `Last connection check: ${Math.round(probeAgeHours / 24)}d ago`;

  const config = {
    connected: {
      ring: "bg-emerald-500 ring-emerald-200",
      label: "QuickBooks connected",
      tooltip: `QuickBooks is connected and the access token can refresh.\n${probeNote}`,
    },
    dead: {
      ring: "bg-red-500 ring-red-200",
      label: "QuickBooks reconnection needed",
      tooltip: `The last connection check confirmed this client's token is dead.\nThey need to reconnect QuickBooks before SNAP can pull their books.\n${probeNote}`,
    },
    not_connected: {
      ring: "bg-gray-400 ring-gray-200",
      label: "Never connected",
      tooltip:
        "SNAP has no QuickBooks tokens for this client. They need to do the initial connect from their client profile.",
    },
  }[status];

  return (
    <span
      className="flex items-center gap-1.5 flex-shrink-0"
      title={`${config.label}\n\n${config.tooltip}`}
      aria-label={config.label}
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ring-4 ${config.ring}`}
      />
    </span>
  );
}

export function BsCleanupPicker({
  clientLinks,
  activeRuns,
  probeAgeHours,
}: {
  clientLinks: ClientLink[];
  activeRuns: ActiveRun[];
  probeAgeHours: number | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | QboStatus>("all");

  const activeByClient = useMemo(() => {
    const map = new Map<string, ActiveRun>();
    for (const run of activeRuns) map.set(run.client_link_id, run);
    return map;
  }, [activeRuns]);

  const counts = useMemo(() => {
    let connected = 0, dead = 0, notConnected = 0;
    for (const c of clientLinks) {
      if (c.qbo_status === "connected") connected++;
      else if (c.qbo_status === "dead") dead++;
      else notConnected++;
    }
    return { connected, dead, notConnected };
  }, [clientLinks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clientLinks.filter((c) => {
      if (filter !== "all" && c.qbo_status !== filter) return false;
      if (!q) return true;
      return (
        c.client_name.toLowerCase().includes(q) ||
        (c.state_province || "").toLowerCase().includes(q) ||
        c.jurisdiction.toLowerCase().includes(q)
      );
    });
  }, [clientLinks, query, filter]);

  function open(c: ClientLink) {
    setNavigatingTo(c.id);
    const active = activeByClient.get(c.id);
    if (active) {
      router.push(`/balance-sheet/${c.id}/cleanup/${active.id}`);
      return;
    }
    router.push(`/balance-sheet/${c.id}/cleanup`);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span className="font-bold uppercase tracking-wide text-[10px] mr-2">
          Pilot
        </span>
        Standalone balance sheet cleanup — test here before we wire it into the
        main 5-step Account Cleanup flow.
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-teal/10 flex-shrink-0">
            <ClipboardCheck size={18} className="text-teal" />
          </div>
          <div className="flex-1">
            <h2 className="font-bold text-navy">Pick a client</h2>
            <p className="text-xs text-ink-slate mt-0.5">
              {clientLinks.length} active client
              {clientLinks.length === 1 ? "" : "s"} · guided BS cleanup with
              module discovery, review, and approved QBO posting
            </p>
          </div>
        </div>

        {/* QBO connection summary + filter chips */}
        <div className="flex items-center gap-2 text-xs flex-wrap border-t border-gray-100 pt-3">
          <span className="font-bold uppercase tracking-wider text-ink-light flex items-center gap-1.5">
            <Activity size={11} /> QuickBooks
          </span>
          <button
            onClick={() => setFilter("all")}
            className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors ${
              filter === "all"
                ? "bg-navy text-white border-navy"
                : "border-gray-200 text-ink-slate hover:border-navy/30"
            }`}
          >
            All {clientLinks.length}
          </button>
          <button
            onClick={() => setFilter("connected")}
            className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors inline-flex items-center gap-1.5 ${
              filter === "connected"
                ? "bg-emerald-600 text-white border-emerald-600"
                : "border-gray-200 text-ink-slate hover:border-emerald-300"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Connected {counts.connected}
          </button>
          <button
            onClick={() => setFilter("dead")}
            disabled={counts.dead === 0}
            className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 ${
              filter === "dead"
                ? "bg-red-600 text-white border-red-600"
                : "border-gray-200 text-ink-slate hover:border-red-300"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Reconnect needed {counts.dead}
          </button>
          <button
            onClick={() => setFilter("not_connected")}
            disabled={counts.notConnected === 0}
            className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 ${
              filter === "not_connected"
                ? "bg-gray-700 text-white border-gray-700"
                : "border-gray-200 text-ink-slate hover:border-gray-400"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            Never connected {counts.notConnected}
          </button>
          {probeAgeHours != null && (
            <span className="ml-auto text-[10px] text-ink-light">
              Last connection check:{" "}
              {probeAgeHours < 1
                ? `${Math.round(probeAgeHours * 60)}m ago`
                : probeAgeHours < 24
                ? `${Math.round(probeAgeHours)}h ago`
                : `${Math.round(probeAgeHours / 24)}d ago`}
            </span>
          )}
        </div>

        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, jurisdiction, or state…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none text-sm"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            {filter !== "all" || query
              ? "No clients match the current filters."
              : "No clients found."}
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {filtered.map((c) => {
              const active = activeByClient.get(c.id);
              const isLoading = navigatingTo === c.id;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => open(c)}
                    disabled={navigatingTo !== null}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                  >
                    <QboStatusDot status={c.qbo_status} probeAgeHours={probeAgeHours} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-navy truncate">
                          {c.client_name}
                        </span>
                        {active && (
                          <span className="text-[10px] font-semibold bg-teal/10 text-teal px-1.5 py-0.5 rounded">
                            {STATUS_LABEL[active.status] || active.status} · continue
                          </span>
                        )}
                        {c.qbo_status === "dead" && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
                            Reconnect QBO
                          </span>
                        )}
                        {c.qbo_status === "not_connected" && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                            Not connected
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-slate mt-0.5">
                        {c.jurisdiction}
                        {c.state_province ? ` · ${c.state_province}` : ""}
                      </div>
                    </div>
                    {isLoading ? (
                      <Loader2 size={14} className="animate-spin text-teal" />
                    ) : (
                      <ArrowRight size={14} className="text-ink-light" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
