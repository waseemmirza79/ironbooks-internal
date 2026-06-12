"use client";

import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";

/**
 * Senior-only: view /today as any bookkeeper. Drives the ?viewas= query
 * param — the server re-scopes every widget to that bookkeeper's clients.
 */
export function ViewAsSelector({
  bookkeepers,
  current,
}: {
  bookkeepers: { id: string; full_name: string }[];
  current: string | null;
}) {
  const router = useRouter();
  return (
    <div className="inline-flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
      <Eye size={13} className="text-ink-slate" />
      <span className="text-xs font-semibold text-ink-slate">Viewing:</span>
      <select
        value={current || ""}
        onChange={(e) =>
          router.push(e.target.value ? `/today?viewas=${e.target.value}` : "/today")
        }
        className="text-xs font-semibold text-navy bg-transparent focus:outline-none cursor-pointer"
      >
        <option value="">Everyone (my view)</option>
        {bookkeepers.map((b) => (
          <option key={b.id} value={b.id}>
            {b.full_name}
          </option>
        ))}
      </select>
    </div>
  );
}
