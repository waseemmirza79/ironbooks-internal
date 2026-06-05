"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Search,
  Users,
  TrendingDown,
  DollarSign,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { DashboardData, ClientHealth, HealthTier } from "@/lib/client-health";

interface BookkeeperOption {
  id: string;
  name: string;
  role: string;
}

interface Props {
  data: DashboardData;
  bookkeepers: BookkeeperOption[];
  activeBookkeeperId: string | null;
}

// ─── Tier visual config — drives colors / icons / copy ────────────────────
//
// Centralized so every card / pill / divider stays consistent.

const TIER_CONFIG: Record<
  HealthTier,
  {
    label: string;
    sublabel: string;
    icon: any;
    /** Used for the summary tile + section divider. */
    accentBg: string;
    accentText: string;
    accentBorder: string;
    /** Used for the per-client card border on the left edge. */
    cardAccent: string;
    /** Pill background + text colors. */
    pillBg: string;
    pillText: string;
  }
> = {
  critical: {
    label: "Critical",
    sublabel: "Needs intervention now",
    icon: AlertTriangle,
    accentBg: "bg-gradient-to-br from-red-50 to-red-100",
    accentText: "text-red-900",
    accentBorder: "border-red-300",
    cardAccent: "border-l-red-500",
    pillBg: "bg-red-600",
    pillText: "text-white",
  },
  at_risk: {
    label: "At risk",
    sublabel: "Watch closely",
    icon: TrendingDown,
    accentBg: "bg-gradient-to-br from-amber-50 to-amber-100",
    accentText: "text-amber-900",
    accentBorder: "border-amber-300",
    cardAccent: "border-l-amber-500",
    pillBg: "bg-amber-500",
    pillText: "text-white",
  },
  healthy: {
    label: "Healthy",
    sublabel: "All signals look good",
    icon: CheckCircle2,
    accentBg: "bg-gradient-to-br from-emerald-50 to-emerald-100",
    accentText: "text-emerald-900",
    accentBorder: "border-emerald-300",
    cardAccent: "border-l-emerald-500",
    pillBg: "bg-emerald-600",
    pillText: "text-white",
  },
  no_data: {
    label: "No data",
    sublabel: "QBO not connected or fetch failed",
    icon: HelpCircle,
    accentBg: "bg-gradient-to-br from-gray-50 to-gray-100",
    accentText: "text-gray-700",
    accentBorder: "border-gray-300",
    cardAccent: "border-l-gray-400",
    pillBg: "bg-gray-500",
    pillText: "text-white",
  },
};

const TIER_ORDER: HealthTier[] = ["critical", "at_risk", "healthy", "no_data"];

// ─── Main component ──────────────────────────────────────────────────────

export function AdvisorDashboard({ data, bookkeepers, activeBookkeeperId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  // Sections start expanded for critical + at_risk (the ones that need
  // action) and collapsed for healthy / no_data (less urgent).
  const [collapsed, setCollapsed] = useState<Set<HealthTier>>(
    new Set(["healthy", "no_data"])
  );

  function toggleSection(tier: HealthTier) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }

  // Filter clients by search across name + bookkeeper. Cheap enough to
  // run on every keystroke for the typical fleet size (50-200 clients).
  const filtered = useMemo(() => {
    if (!search.trim()) return data.clients;
    const q = search.toLowerCase();
    return data.clients.filter(
      (c) =>
        c.clientName.toLowerCase().includes(q) ||
        (c.assignedBookkeeperName || "").toLowerCase().includes(q) ||
        c.topReasons.some((r) => r.toLowerCase().includes(q))
    );
  }, [data.clients, search]);

  // Group filtered clients by tier
  const byTier = useMemo(() => {
    const out: Record<HealthTier, ClientHealth[]> = {
      critical: [],
      at_risk: [],
      healthy: [],
      no_data: [],
    };
    for (const c of filtered) out[c.tier].push(c);
    return out;
  }, [filtered]);

  function changeBookkeeper(bookkeeperId: string) {
    const params = new URLSearchParams();
    if (bookkeeperId !== "all") params.set("bookkeeper", bookkeeperId);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="px-8 py-6 max-w-7xl mx-auto space-y-6">
      {/* Top filter strip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-slate"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients, bookkeepers, or issues…"
              className="pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg w-80 outline-none focus:border-teal"
            />
          </div>
          {/* Bookkeeper filter */}
          <div className="inline-flex items-center gap-2 text-xs text-ink-slate">
            <Users size={14} />
            <select
              value={activeBookkeeperId || "all"}
              onChange={(e) => changeBookkeeper(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-teal"
            >
              <option value="all">All bookkeepers</option>
              {bookkeepers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.role !== "bookkeeper" ? ` (${b.role})` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="text-[11px] text-ink-slate flex items-center gap-1">
          <Clock size={11} />
          Computed {timeAgo(data.computedAt)}
        </div>
      </div>

      {/* Summary tiles — 4-up grid showing tier counts + money under management */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryTile
          tier="critical"
          count={data.summary.critical}
          totalClients={data.summary.total}
        />
        <SummaryTile
          tier="at_risk"
          count={data.summary.at_risk}
          totalClients={data.summary.total}
        />
        <SummaryTile
          tier="healthy"
          count={data.summary.healthy}
          totalClients={data.summary.total}
        />
        <MoneyTile
          cashManaged={data.summary.total_cash_managed}
          arOutstanding={data.summary.total_ar_outstanding}
          totalClients={data.summary.total}
        />
      </div>

      {/* Sections by tier */}
      {TIER_ORDER.map((tier) => {
        const clients = byTier[tier];
        const cfg = TIER_CONFIG[tier];
        const isCollapsed = collapsed.has(tier);

        // Hide entire section if zero clients in this tier AND no search
        // active (when searching, show the empty state so the user knows).
        if (clients.length === 0 && !search.trim()) return null;

        return (
          <section
            key={tier}
            className={`rounded-2xl border ${cfg.accentBorder} ${cfg.accentBg} overflow-hidden`}
          >
            <button
              onClick={() => toggleSection(tier)}
              className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-black/5 transition-colors"
            >
              <div className="flex items-center gap-3">
                <cfg.icon size={20} className={cfg.accentText} />
                <div className="text-left">
                  <div className={`text-base font-bold ${cfg.accentText}`}>
                    {cfg.label}{" "}
                    <span className="opacity-70 font-semibold">
                      ({clients.length})
                    </span>
                  </div>
                  <div className={`text-xs ${cfg.accentText} opacity-70`}>
                    {cfg.sublabel}
                  </div>
                </div>
              </div>
              {isCollapsed ? (
                <ChevronRight size={18} className={cfg.accentText} />
              ) : (
                <ChevronDown size={18} className={cfg.accentText} />
              )}
            </button>

            {!isCollapsed && (
              <div className="px-3 pb-3 space-y-2">
                {clients.length === 0 ? (
                  <div className="bg-white rounded-xl p-6 text-center text-sm text-ink-slate">
                    {search.trim()
                      ? `No ${cfg.label.toLowerCase()} clients match "${search}".`
                      : `No clients in this tier.`}
                  </div>
                ) : (
                  clients.map((c) => <ClientCard key={c.clientLinkId} client={c} />)
                )}
              </div>
            )}
          </section>
        );
      })}

      {/* Footer note */}
      <div className="text-[11px] text-ink-slate/70 text-center max-w-2xl mx-auto">
        Health scores are computed in real-time from live QBO data + SNAP's
        internal state. Scoring is weighted toward cash runway and bills-vs-cash
        because those signals predict insolvency earliest. Refresh to recompute.
      </div>
    </div>
  );
}

// ─── Summary tiles ───────────────────────────────────────────────────────

function SummaryTile({
  tier,
  count,
  totalClients,
}: {
  tier: HealthTier;
  count: number;
  totalClients: number;
}) {
  const cfg = TIER_CONFIG[tier];
  const pct = totalClients > 0 ? Math.round((count / totalClients) * 100) : 0;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${cfg.accentBorder} ${cfg.accentBg} p-5`}
    >
      <div className="flex items-start justify-between mb-2">
        <cfg.icon size={22} className={cfg.accentText} />
        <span
          className={`text-[10px] font-bold uppercase tracking-wide ${cfg.accentText} opacity-70`}
        >
          {pct}%
        </span>
      </div>
      <div className={`text-4xl font-bold ${cfg.accentText}`}>{count}</div>
      <div className={`text-xs font-semibold ${cfg.accentText} mt-0.5`}>
        {cfg.label}
      </div>
      <div className={`text-[11px] ${cfg.accentText} opacity-70`}>
        {cfg.sublabel}
      </div>
    </div>
  );
}

function MoneyTile({
  cashManaged,
  arOutstanding,
  totalClients,
}: {
  cashManaged: number;
  arOutstanding: number;
  totalClients: number;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-teal/30 bg-gradient-to-br from-teal-lighter/50 to-white p-5">
      <div className="flex items-start justify-between mb-2">
        <DollarSign size={22} className="text-teal" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-teal opacity-70">
          {totalClients} clients
        </span>
      </div>
      <div className="text-2xl font-bold text-navy">
        {fmtCompact(cashManaged)}
      </div>
      <div className="text-xs font-semibold text-navy mt-0.5">Cash managed</div>
      <div className="text-[11px] text-ink-slate mt-2">
        + {fmtCompact(arOutstanding)} in A/R
      </div>
    </div>
  );
}

// ─── Per-client card ─────────────────────────────────────────────────────

function ClientCard({ client }: { client: ClientHealth }) {
  const cfg = TIER_CONFIG[client.tier];
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 border-l-4 ${cfg.cardAccent} overflow-hidden hover:shadow-md transition-shadow`}
    >
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Link
              href={`/clients/${client.clientLinkId}`}
              className="text-base font-bold text-navy hover:text-teal truncate"
            >
              {client.clientName}
            </Link>
            <ScoreBadge score={client.score} tier={client.tier} />
            {client.assignedBookkeeperName && (
              <span className="text-[11px] text-ink-slate">
                · {client.assignedBookkeeperName}
              </span>
            )}
          </div>

          {/* Top reasons — first 2 always visible, rest in expand */}
          <ul className="space-y-0.5 mb-2">
            {client.topReasons.slice(0, 2).map((r, i) => (
              <li
                key={i}
                className="text-xs text-ink-slate flex items-start gap-1.5"
              >
                <AlertCircle
                  size={11}
                  className={`shrink-0 mt-0.5 ${
                    client.tier === "critical"
                      ? "text-red-500"
                      : client.tier === "at_risk"
                      ? "text-amber-500"
                      : client.tier === "no_data"
                      ? "text-gray-400"
                      : "text-emerald-500"
                  }`}
                />
                <span>{r}</span>
              </li>
            ))}
          </ul>

          {/* Key money signals chip row */}
          <div className="flex items-center gap-2 text-[11px] text-ink-slate flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded">
              <DollarSign size={10} />
              {fmtCompact(client.cashOnHand)} cash
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded">
              {fmtCompact(client.openAr)} A/R
            </span>
            {client.error && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 rounded">
                <AlertTriangle size={10} />
                {client.error}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Link
            href={`/clients/${client.clientLinkId}`}
            className="inline-flex items-center gap-1 text-xs font-bold text-teal hover:text-teal-dark border border-teal/30 hover:border-teal bg-white px-3 py-1.5 rounded-lg transition-colors"
          >
            Open
            <ExternalLink size={11} />
          </Link>
          {client.dimensions.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[11px] text-ink-slate hover:text-navy flex items-center gap-0.5"
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Details
            </button>
          )}
        </div>
      </div>

      {/* Expanded per-dimension breakdown */}
      {expanded && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-100 bg-gray-50/50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
            {client.dimensions.map((d) => (
              <DimensionRow key={d.key} dim={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreBadge({ score, tier }: { score: number; tier: HealthTier }) {
  const cfg = TIER_CONFIG[tier];
  return (
    <span
      className={`inline-flex items-center text-[10px] font-bold ${cfg.pillBg} ${cfg.pillText} px-2 py-0.5 rounded-full`}
    >
      {tier === "no_data" ? "—" : `${score}/100`}
    </span>
  );
}

function DimensionRow({ dim }: { dim: any }) {
  const color =
    dim.score >= 70
      ? "bg-emerald-500"
      : dim.score >= 40
      ? "bg-amber-500"
      : "bg-red-500";
  return (
    <div className="bg-white rounded-lg p-2 border border-gray-100">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-bold text-navy">{dim.label}</div>
        <div className="text-[10px] font-bold text-ink-slate">
          {dim.score}/100
        </div>
      </div>
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden mb-1.5">
        <div className={`h-full ${color}`} style={{ width: `${dim.score}%` }} />
      </div>
      <div className="text-[11px] text-ink-slate leading-snug">{dim.reason}</div>
      {dim.metric && (
        <div className="text-[10px] text-ink-light mt-0.5 font-mono">{dim.metric}</div>
      )}
    </div>
  );
}

// ─── Formatting helpers ─────────────────────────────────────────────────

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
