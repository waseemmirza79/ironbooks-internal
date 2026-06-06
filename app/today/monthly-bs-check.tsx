"use client";

import { useState } from "react";
import { Loader2, BarChart3 } from "lucide-react";

export function MonthlyBsCheckButton({ clientLinkId }: { clientLinkId: string }) {
  const [loading, setLoading] = useState(false);

  async function startMonthly() {
    setLoading(true);
    try {
      const res = await fetch("/api/cleanup/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      window.location.href = `/balance-sheet/${clientLinkId}/cleanup/${data.run_id}`;
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); startMonthly(); }}
      disabled={loading}
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded border border-teal/30 text-teal hover:bg-teal/5 disabled:opacity-50"
      title="Run monthly BS health check"
    >
      {loading ? <Loader2 size={10} className="animate-spin" /> : <BarChart3 size={10} />}
      BS check
    </button>
  );
}
