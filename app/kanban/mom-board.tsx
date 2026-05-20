"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { ClientCard } from "./client-card";
import { ClientPanel } from "./client-panel";
import type { KanbanCard, KanbanBookkeeper, MomStage } from "./types";

const COLUMNS: { key: MomStage; label: string; color: string }[] = [
  { key: "month_open",   label: "Month Open",    color: "#64748B" },
  { key: "in_progress",  label: "In Progress",   color: "#3B82F6" },
  { key: "review_send",  label: "Review & Send", color: "#8B5CF6" },
  { key: "month_closed", label: "Month Closed",  color: "#10B981" },
];

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

interface Props {
  bookkeepers: KanbanBookkeeper[];
  bookkeeperFilter: string;
  canEdit: boolean;
}

export function MomBoard({ bookkeepers, bookkeeperFilter, canEdit }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [columns, setColumns] = useState<Record<string, { cards: KanbanCard[]; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [openCard, setOpenCard] = useState<{ card: KanbanCard; stage: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    setPages({});
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month), limit: "20" });
      if (bookkeeperFilter) params.set("bookkeeper_id", bookkeeperFilter);
      const res = await fetch(`/api/kanban/mom?${params}`);
      const data = await res.json();
      setColumns(data.columns || {});
    } finally {
      setLoading(false);
    }
  }, [year, month, bookkeeperFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function prevMonth() {
    if (month === 1) { setYear((y) => y - 1); setMonth(12); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setYear((y) => y + 1); setMonth(1); }
    else setMonth((m) => m + 1);
  }

  async function loadMore(key: string) {
    const nextPage = (pages[key] || 0) + 1;
    setLoadingMore(key);
    setPages((p) => ({ ...p, [key]: nextPage }));
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month), page: String(nextPage), limit: "20" });
      if (bookkeeperFilter) params.set("bookkeeper_id", bookkeeperFilter);
      const res = await fetch(`/api/kanban/mom?${params}`);
      const data = await res.json();
      setColumns((prev) => ({
        ...prev,
        [key]: {
          cards: [...(prev[key]?.cards || []), ...(data.columns[key]?.cards || [])],
          total: data.columns[key]?.total ?? prev[key]?.total ?? 0,
        },
      }));
    } finally {
      setLoadingMore(null);
    }
  }

  return (
    <>
      {/* Month navigator */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <ChevronLeft size={16} className="text-ink-slate" />
          </button>
          <span className="text-sm font-bold text-navy w-36 text-center">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <ChevronRight size={16} className="text-ink-slate" />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-ink-slate">
            {Object.values(columns).reduce((s, c) => s + (c.total || 0), 0)} clients
          </div>
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 text-xs text-ink-slate hover:text-navy"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="animate-spin text-teal" size={28} />
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-300px)]">
          {COLUMNS.map(({ key, label, color }) => {
            const col = columns[key] || { cards: [], total: 0 };
            const hasMore = col.cards.length < col.total;

            return (
              <div key={key} className="flex-shrink-0 w-72 flex flex-col">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-xs font-bold text-navy uppercase tracking-wider">{label}</span>
                  <span className="ml-auto text-xs font-semibold text-ink-slate bg-gray-100 px-1.5 py-0.5 rounded-full">
                    {col.total}
                  </span>
                </div>

                <div className="flex-1 space-y-2.5">
                  {col.cards.length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-gray-100 p-6 text-center">
                      <p className="text-xs text-ink-light">No clients here</p>
                    </div>
                  ) : (
                    col.cards.map((card) => (
                      <ClientCard
                        key={card.id}
                        card={card}
                        stage={key}
                        onOpen={(c) => setOpenCard({ card: c, stage: key })}
                        onRefresh={fetchData}
                        canEdit={canEdit}
                      />
                    ))
                  )}

                  {hasMore && (
                    <button
                      onClick={() => loadMore(key)}
                      disabled={loadingMore === key}
                      className="w-full py-2 text-xs text-ink-slate hover:text-navy flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      {loadingMore === key
                        ? <Loader2 size={12} className="animate-spin" />
                        : <ChevronDown size={12} />}
                      {loadingMore === key ? "Loading…" : `Load more (${col.total - col.cards.length} remaining)`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openCard && (
        <ClientPanel
          card={openCard.card}
          stage={openCard.stage}
          bookkeepers={bookkeepers}
          canEdit={canEdit}
          onClose={() => setOpenCard(null)}
          onRefresh={fetchData}
        />
      )}
    </>
  );
}
