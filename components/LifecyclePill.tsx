import { LIFECYCLE_META, type LifecycleStatus } from "@/lib/client-lifecycle";

/**
 * Single source of truth for showing where a client sits in the lifecycle —
 * Onboarding/Cleanup (Pipeline) vs Review vs Live (Production). Keyed off
 * deriveLifecycleStatus()/LIFECYCLE_META so every surface (directory, profile
 * header, boards) reads the same label + color. Renders nothing for an unknown
 * status so callers can pass it unconditionally.
 */
export function LifecyclePill({
  status,
  size = "sm",
}: {
  status: LifecycleStatus | null | undefined;
  size?: "sm" | "md";
}) {
  if (!status || !LIFECYCLE_META[status]) return null;
  const m = LIFECYCLE_META[status];
  const pad = size === "md" ? "px-3 py-1 text-sm" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-md font-semibold ${pad} ${m.tone}`}
      title={m.group === "Live" ? "In production — books maintained daily" : `${m.group}: ${m.label}`}
    >
      {m.label}
    </span>
  );
}
