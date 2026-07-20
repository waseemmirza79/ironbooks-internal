"use client";

import Link from "next/link";

/**
 * Tab strip for the Home / Oversight hub pages — links that swap the ?tab=
 * query param so each hub renders one merged section at a time (only the
 * active section is server-rendered, so heavy tabs cost nothing until opened).
 */
export function HubTabs({
  basePath,
  tabs,
  active,
}: {
  basePath: string;
  tabs: { key: string; label: string; icon?: any; count?: number }[];
  active: string;
}) {
  return (
    <div className="px-8 pt-5">
      <div className="flex items-center gap-1 border-b border-gray-200">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === active;
          return (
            <Link
              key={t.key}
              href={`${basePath}?tab=${t.key}`}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                isActive
                  ? "border-teal text-navy"
                  : "border-transparent text-ink-slate hover:text-navy hover:border-gray-200"
              }`}
            >
              {Icon && <Icon size={15} />}
              {t.label}
              {typeof t.count === "number" && t.count > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-teal text-white text-[10px] font-bold">
                  {t.count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
