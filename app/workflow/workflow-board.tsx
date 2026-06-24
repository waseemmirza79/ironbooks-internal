"use client";

import { useState } from "react";
import { ClipboardCheck, ListChecks, UserPlus } from "lucide-react";
import { CleanupBoard } from "../cleanup/cleanup-board";
import { ProductionBoard } from "../production/production-board";
import { OnboardingBoard } from "../onboarding/onboarding-board";
import type { OnboardingLead } from "@/lib/onboarding";

type View = "onboarding" | "cleanup" | "production";

/**
 * Segmented Onboarding ⇄ Cleanup ⇄ Production switch over the existing boards.
 * Only the active segment mounts (each board self-fetches), so switching is a
 * cheap remount and there's no double-loading.
 */
export function WorkflowBoard({
  initialView,
  isSenior,
  onboardingLeads,
  bookkeepers,
}: {
  initialView: View;
  isSenior: boolean;
  onboardingLeads: OnboardingLead[];
  bookkeepers: { id: string; full_name: string }[];
}) {
  // Non-seniors never see the Onboarding segment — clamp a stray deep link.
  const start: View = !isSenior && initialView === "onboarding" ? "cleanup" : initialView;
  const [view, setView] = useState<View>(start);

  const segments: { id: View; label: string; icon: any; senior?: boolean }[] = [
    { id: "onboarding", label: "Onboarding", icon: UserPlus, senior: true },
    { id: "cleanup", label: "Cleanup", icon: ClipboardCheck },
    { id: "production", label: "Production", icon: ListChecks },
  ];

  return (
    <div className="space-y-5">
      <div className="inline-flex items-center gap-1 rounded-xl bg-gray-100 p-1">
        {segments
          .filter((s) => !s.senior || isSenior)
          .map((s) => {
            const Icon = s.icon;
            const active = view === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setView(s.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                  active ? "bg-white text-navy shadow-sm" : "text-ink-slate hover:text-navy"
                }`}
              >
                <Icon size={15} />
                {s.label}
              </button>
            );
          })}
      </div>

      {view === "onboarding" && isSenior && (
        <OnboardingBoard leads={onboardingLeads} bookkeepers={bookkeepers} />
      )}
      {view === "cleanup" && <CleanupBoard />}
      {view === "production" && <ProductionBoard />}
    </div>
  );
}
