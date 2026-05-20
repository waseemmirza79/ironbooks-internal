"use client";

import { useState } from "react";
import { OnboardingBoard } from "./onboarding-board";
import { MomBoard } from "./mom-board";
import type { KanbanBookkeeper } from "./types";

interface Props {
  bookkeepers: KanbanBookkeeper[];
  canEdit: boolean;
  currentUserId: string;
}

export function KanbanClient({ bookkeepers, canEdit, currentUserId }: Props) {
  const [tab, setTab] = useState<"onboarding" | "mom">("onboarding");
  const [bookkeeperFilter, setBookkeeperFilter] = useState("");

  return (
    <div>
      {/* Tab bar + filter */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
          <button
            onClick={() => setTab("onboarding")}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
              tab === "onboarding"
                ? "bg-white text-navy shadow-sm"
                : "text-ink-slate hover:text-navy"
            }`}
          >
            Onboarding
          </button>
          <button
            onClick={() => setTab("mom")}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
              tab === "mom"
                ? "bg-white text-navy shadow-sm"
                : "text-ink-slate hover:text-navy"
            }`}
          >
            Month-over-Month
          </button>
        </div>

        {/* Bookkeeper filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-ink-slate">Bookkeeper:</label>
          <select
            value={bookkeeperFilter}
            onChange={(e) => setBookkeeperFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-navy focus:outline-none focus:border-teal bg-white"
          >
            <option value="">All bookkeepers</option>
            <option value={currentUserId}>My clients</option>
            <option value="unassigned">Unassigned</option>
            {bookkeepers.map((bk) => (
              <option key={bk.id} value={bk.id}>{bk.full_name}</option>
            ))}
          </select>
        </div>
      </div>

      {tab === "onboarding" ? (
        <OnboardingBoard
          bookkeepers={bookkeepers}
          bookkeeperFilter={bookkeeperFilter}
          canEdit={canEdit}
        />
      ) : (
        <MomBoard
          bookkeepers={bookkeepers}
          bookkeeperFilter={bookkeeperFilter}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
