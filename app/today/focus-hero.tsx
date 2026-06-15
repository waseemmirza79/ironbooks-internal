import Link from "next/link";
import { ArrowRight, Sparkles, Target } from "lucide-react";
import type { TodayHero } from "@/lib/today-priority";

/**
 * "Focus now" hero — the single most important thing right now, computed by
 * computeTodayPriority. Presentational only. When there's nothing pressing
 * it degrades to a calm "you're clear" state so the page never feels alarmy
 * when work is actually done.
 */
export function FocusHero({
  hero,
  autoExecuted,
  dueSoon,
}: {
  hero: TodayHero | null;
  autoExecuted: number;
  dueSoon: number;
}) {
  if (!hero) {
    return (
      <div className="rounded-2xl border border-teal/30 bg-teal-lighter px-6 py-5 flex items-center gap-4">
        <div className="p-2.5 rounded-xl bg-white/70 flex-shrink-0">
          <Sparkles className="text-teal" size={22} />
        </div>
        <div className="min-w-0">
          <div className="text-base font-bold text-navy">You&apos;re all caught up</div>
          <div className="text-sm text-ink-slate mt-0.5">
            Nothing needs your decision right now
            {autoExecuted > 0 && (
              <> · <span className="font-semibold text-teal">{autoExecuted}</span> auto-posted to QuickBooks in the last 24h</>
            )}
            {dueSoon > 0 && (
              <> · <span className="font-semibold text-navy">{dueSoon}</span> due soon</>
            )}
            .
          </div>
        </div>
      </div>
    );
  }

  const tone =
    hero.tone === "red"
      ? { border: "border-l-red-500", bg: "bg-red-50/60", chip: "text-red-700 bg-red-100", btn: "bg-red-600 hover:bg-red-700" }
      : hero.tone === "amber"
      ? { border: "border-l-amber-500", bg: "bg-amber-50/60", chip: "text-amber-800 bg-amber-100", btn: "bg-teal hover:bg-teal-dark" }
      : { border: "border-l-teal", bg: "bg-teal-lighter", chip: "text-teal bg-white/70", btn: "bg-teal hover:bg-teal-dark" };

  return (
    <div className={`rounded-2xl border border-gray-200 border-l-4 ${tone.border} ${tone.bg} px-6 py-5`}>
      <div className="flex items-center gap-2 mb-2">
        <Target size={13} className="text-ink-light" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-ink-light">Focus now</span>
      </div>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-lg font-bold text-navy truncate">{hero.client}</div>
          <div className={`inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-xs font-semibold ${tone.chip}`}>
            {hero.whyNow}
          </div>
        </div>
        <Link
          href={hero.ctaHref}
          className={`inline-flex items-center gap-2 ${tone.btn} text-white text-sm font-semibold px-5 py-2.5 rounded-lg flex-shrink-0`}
        >
          {hero.ctaLabel}
          <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  );
}
