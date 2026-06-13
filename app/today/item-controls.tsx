"use client";

import { useState } from "react";
import { Check, CalendarClock, X, Loader2, Undo2 } from "lucide-react";

/**
 * Manager controls for a Today-queue item: resolve, hide, set/modify a
 * due date. Optimistic — on resolve/hide it removes itself from the DOM;
 * on a date change it persists and shows the new due chip. Keyed by the
 * widget-supplied item_key. Renders nothing for non-managers (the parent
 * decides whether to mount it).
 */
export function TodayItemControls({
  itemKey,
  dueDate,
  resolved,
}: {
  itemKey: string;
  dueDate: string | null;
  resolved?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [due, setDue] = useState(dueDate || "");
  const [editingDue, setEditingDue] = useState(false);

  async function act(action: string, due_date?: string | null) {
    setBusy(true);
    try {
      const res = await fetch("/api/today/item-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_key: itemKey, action, due_date }),
      });
      if (!res.ok) throw new Error();
      if (action === "resolve" || action === "hide") setGone(true);
      if (action === "set_due") setEditingDue(false);
    } catch {
      // best-effort; leave UI as-is
    } finally {
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
        <Check size={11} /> Resolved
      </span>
    );
  }

  const overdue = due && due < new Date().toISOString().slice(0, 10);

  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {editingDue ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5"
          />
          <button
            onClick={() => act("set_due", due || null)}
            disabled={busy}
            className="text-[11px] font-semibold text-teal hover:text-teal-dark"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : "Save"}
          </button>
          <button onClick={() => setEditingDue(false)} className="text-ink-light hover:text-navy">
            <X size={11} />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setEditingDue(true)}
          className={`text-[11px] font-semibold inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
            due
              ? overdue
                ? "bg-red-100 text-red-700"
                : "bg-gray-100 text-ink-slate"
              : "text-teal hover:text-teal-dark"
          }`}
          title="Set or change due date"
        >
          <CalendarClock size={11} />
          {due ? `Due ${due}${overdue ? " ⚠" : ""}` : "Set due"}
        </button>
      )}
      <button
        onClick={() => act(resolved ? "unresolve" : "resolve")}
        disabled={busy}
        className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900 inline-flex items-center gap-1"
        title="Mark resolved"
      >
        {resolved ? <Undo2 size={11} /> : <Check size={11} />}
        {resolved ? "Reopen" : "Resolve"}
      </button>
    </div>
  );
}
