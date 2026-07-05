"use client";

import { useEffect, useState } from "react";
import { Flag, Loader2, CheckCircle2, X, AlertTriangle, ChevronDown } from "lucide-react";

/**
 * Escalation UI, shared by every board:
 *
 *  <EscalateMenu>       — the two-click raise: pre-baked reason picker +
 *                         optional note/assignee. Feels like tagging, not
 *                         process (typing an essay = people Slack instead).
 *  <EscalationStrip>    — thin red board-top strip ("⚠ 2 escalated: …");
 *                         clicking opens the drawer ON the board — triage
 *                         never requires leaving the page.
 *
 * Data comes from /api/escalations; boards refresh via onChanged().
 */

export const ESCALATION_REASONS = [
  { kind: "general", label: "Needs senior review" },
  { kind: "billing", label: "Billing issue" },
  { kind: "client_relationship", label: "Client relationship" },
  { kind: "general", label: "Waiting on a decision" },
] as const;

export interface EscalationRow {
  id: string;
  client_link_id: string;
  client_name: string;
  kind: string;
  reason: string;
  note: string | null;
  priority: "low" | "high";
  status: "open" | "resolved";
  raised_by_name: string | null;
  assignee_name: string | null;
  resolved_by_name?: string | null;
  resolution_note?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/** Two-click raise: flag button → reason picker (+ optional note). */
export function EscalateMenu({
  clientLinkId,
  clientName,
  seniors,
  onRaised,
  small,
}: {
  clientLinkId: string;
  clientName: string;
  /** Optional assignee choices (id + name); pass [] to skip the picker. */
  seniors: { id: string; full_name: string }[];
  onRaised: () => void;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function raise(reason: string, kind: string) {
    setBusy(reason);
    setError("");
    try {
      const res = await fetch("/api/escalations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          reason,
          kind,
          note: note.trim() || undefined,
          assignee_id: assignee || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setOpen(false);
      setNote("");
      setAssignee("");
      onRaised();
    } catch (e: any) {
      setError(e?.message || "Couldn't escalate");
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`Escalate ${clientName} to a senior`}
        className={`inline-flex items-center gap-1 rounded border border-gray-200 text-ink-light hover:text-red-700 hover:border-red-300 hover:bg-red-50 ${
          small ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-1 text-[11px]"
        }`}
      >
        <Flag size={small ? 10 : 12} />
        {!small && "Escalate"}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-40 w-64 bg-white rounded-xl border border-gray-200 shadow-xl p-2.5 space-y-2 cursor-default text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-light">
            Escalate {clientName}
          </div>
          <div className="flex flex-col gap-1">
            {ESCALATION_REASONS.map((r) => (
              <button
                key={r.label}
                onClick={() => raise(r.label, r.kind)}
                disabled={!!busy}
                className="flex items-center gap-1.5 text-left text-xs font-semibold text-navy rounded-lg border border-gray-100 hover:border-red-200 hover:bg-red-50 px-2 py-1.5 disabled:opacity-50"
              >
                {busy === r.label ? <Loader2 size={11} className="animate-spin" /> : <Flag size={11} className="text-red-500" />}
                {r.label}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note…"
            maxLength={500}
            className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200"
          />
          {seniors.length > 0 && (
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-slate"
            >
              <option value="">Assign to… (optional)</option>
              {seniors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          )}
          {error && <div className="text-[10px] text-red-700">{error}</div>}
          <button onClick={() => setOpen(false)} className="text-[10px] text-ink-light hover:text-navy">
            Cancel
          </button>
        </div>
      )}
    </span>
  );
}

/** Board-top strip + on-board drawer. Renders nothing when the board is clean. */
export function EscalationStrip({
  clientIds,
  onChanged,
  alwaysOpen = false,
}: {
  /** Scope the strip to this board's clients; null = all. */
  clientIds: string[] | null;
  /** Called after a resolve so the parent board can refresh badges. */
  onChanged?: () => void;
  /** /approvals mode: list always expanded, no toggle. */
  alwaysOpen?: boolean;
}) {
  const [rows, setRows] = useState<EscalationRow[]>([]);
  const [open, setOpen] = useState(alwaysOpen);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/escalations?status=open");
      const j = await res.json();
      if (res.ok) setRows(j.escalations || []);
    } catch {
      /* keep prior */
    }
  }
  useEffect(() => {
    load();
  }, []);

  const scoped = clientIds ? rows.filter((r) => clientIds.includes(r.client_link_id)) : rows;
  if (scoped.length === 0) return null;

  async function resolve(id: string) {
    const note = window.prompt("Resolution note (optional):") ?? "";
    setBusyId(id);
    try {
      const res = await fetch(`/api/escalations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", resolution_note: note.trim() || undefined }),
      });
      if (res.ok) {
        await load();
        onChanged?.();
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => !alwaysOpen && setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-left ${
          alwaysOpen ? "cursor-default" : "hover:bg-red-100/70"
        }`}
      >
        <AlertTriangle size={14} className="text-red-700 flex-shrink-0" />
        <strong className="text-red-900">
          {scoped.length} escalated
        </strong>
        <span className="text-red-800 truncate">
          {scoped.slice(0, 4).map((r) => r.client_name).join(", ")}
          {scoped.length > 4 ? "…" : ""}
        </span>
        {!alwaysOpen && (
          <ChevronDown size={14} className={`ml-auto text-red-700 transition-transform ${open ? "rotate-180" : ""}`} />
        )}
      </button>

      {open && (
        <ul className="mt-1.5 rounded-lg border border-red-200 bg-white divide-y divide-red-50 overflow-hidden">
          {scoped.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
              <Flag size={13} className={`flex-shrink-0 mt-0.5 ${r.priority === "high" ? "text-red-600" : "text-amber-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-navy">{r.client_name}</span>
                  <span className="text-xs text-red-800 font-medium">{r.reason}</span>
                  <span className="text-[10px] text-ink-light">
                    {ago(r.created_at)}
                    {r.raised_by_name ? ` · by ${r.raised_by_name}` : ""}
                    {r.assignee_name ? ` · → ${r.assignee_name}` : " · unassigned"}
                  </span>
                </div>
                {r.note && <div className="text-xs text-ink-slate mt-0.5">{r.note}</div>}
              </div>
              <button
                onClick={() => resolve(r.id)}
                disabled={busyId === r.id}
                className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg px-2.5 py-1.5 flex-shrink-0"
              >
                {busyId === r.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
