"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Wallet, ArrowRight, CheckCircle2 } from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  cleanup_completed_at: string | null;
  assigned_bookkeeper_id: string | null;
}

export function ArRecoveryPicker({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clientLinks;
    return clientLinks.filter((c) =>
      c.client_name.toLowerCase().includes(q) ||
      (c.state_province || "").toLowerCase().includes(q) ||
      c.jurisdiction.toLowerCase().includes(q)
    );
  }, [clientLinks, query]);

  function open(c: ClientLink) {
    setNavigatingTo(c.id);
    router.push(`/balance-sheet/${c.id}/ar-recovery`);
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-100 flex-shrink-0">
            <Wallet size={18} className="text-amber-700" />
          </div>
          <div className="flex-1">
            <h2 className="font-bold text-navy">Pick a client</h2>
            <p className="text-xs text-ink-slate mt-0.5">
              {clientLinks.length} active client{clientLinks.length === 1 ? "" : "s"} ·
              opens the A/R Recovery toolkit (UF Audit, UF → A/R matcher, Uncategorized Income Recovery)
            </p>
          </div>
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
            No clients match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {filtered.map((c) => {
              const isLoading = navigatingTo === c.id;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => open(c)}
                    disabled={navigatingTo !== null}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-navy truncate">
                          {c.client_name}
                        </span>
                        {c.cleanup_completed_at && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded"
                            title="Cleanup is complete"
                          >
                            <CheckCircle2 size={9} />
                            cleanup done
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-slate mt-0.5">
                        {c.jurisdiction}
                        {c.state_province ? ` · ${c.state_province}` : ""}
                      </div>
                    </div>
                    <ArrowRight
                      size={14}
                      className={`text-ink-light ${isLoading ? "animate-pulse" : ""}`}
                    />
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
