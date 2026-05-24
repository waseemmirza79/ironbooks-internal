"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  X, MessageSquare, Plus, Trash2, Loader2, Bell, ExternalLink,
  CheckCircle2, Zap, PauseCircle, UserCheck, Download, Wallet, ArrowRight,
} from "lucide-react";
import type { KanbanCard, KanbanBookkeeper } from "./types";

interface ClientPanelProps {
  card: KanbanCard;
  stage: string;
  bookkeepers: KanbanBookkeeper[];
  canEdit: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

interface Note {
  id: string;
  body: string;
  reminder_at: string | null;
  created_at: string;
  author_id: string;
  users: { full_name: string; avatar_url: string | null } | null;
}

export function ClientPanel({ card, stage, bookkeepers, canEdit, onClose, onRefresh }: ClientPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [newNote, setNewNote] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [stripeUrl, setStripeUrl] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Local optimistic state for the comms checkboxes. The kanban API only
  // refreshes the underlying `card` prop on the next full board refresh,
  // so without this the checkbox would visually snap back until then.
  const [askSent, setAskSent] = useState<boolean>(!!card.ask_client_email_sent_at);
  const [stripeReqSent, setStripeReqSent] = useState<boolean>(
    !!card.stripe_request_sent_confirmed_at
  );
  const [togglingField, setTogglingField] = useState<string | null>(null);

  async function toggleCommsSent(
    field: "ask_client_sent" | "stripe_request_sent",
    next: boolean
  ) {
    setTogglingField(field);
    // Optimistic update — flip immediately, revert on failure.
    if (field === "ask_client_sent") setAskSent(next);
    else setStripeReqSent(next);
    try {
      const res = await fetch(`/api/clients/${card.id}/comms-tracker`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch {
      // Revert
      if (field === "ask_client_sent") setAskSent(!next);
      else setStripeReqSent(!next);
    } finally {
      setTogglingField(null);
    }
  }

  useEffect(() => {
    fetchNotes();
  }, [card.id]);

  async function fetchNotes() {
    setLoadingNotes(true);
    try {
      const res = await fetch(`/api/clients/${card.id}/notes`);
      const data = await res.json();
      setNotes(data.notes || []);
    } finally {
      setLoadingNotes(false);
    }
  }

  async function addNote() {
    if (!newNote.trim()) return;
    setSavingNote(true);
    try {
      await fetch(`/api/clients/${card.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newNote.trim(), reminder_at: reminderAt || null }),
      });
      setNewNote("");
      setReminderAt("");
      await fetchNotes();
      onRefresh();
    } finally {
      setSavingNote(false);
    }
  }

  async function deleteNote(noteId: string) {
    await fetch(`/api/clients/${card.id}/notes?note_id=${noteId}`, { method: "DELETE" });
    await fetchNotes();
    onRefresh();
  }

  async function act(endpoint: string, body?: object) {
    setActing(true);
    setActionMsg("");
    try {
      const res = await fetch(`/api/clients/${card.id}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.url) setStripeUrl(data.url);
      onRefresh();
      onClose();
    } catch (e: any) {
      setActionMsg(e.message);
    } finally {
      setActing(false);
    }
  }

  async function assignBookkeeper(bookkeeeperId: string | null) {
    await fetch(`/api/clients/${card.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookkeeper_id: bookkeeeperId }),
    });
    onRefresh();
  }

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="relative w-full max-w-md bg-white shadow-2xl border-l border-gray-100 overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="font-bold text-navy text-lg leading-tight">{card.client_name}</h2>
            <div className="text-xs text-ink-slate mt-0.5">
              {card.jurisdiction}{card.state_province ? ` · ${card.state_province}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-6">

          {/* Stripe status */}
          {card.stripe_detected && (
            <div className={`rounded-xl p-3.5 border ${
              card.stripe_connected
                ? "bg-green-50 border-green-200"
                : "bg-amber-50 border-amber-200"
            }`}>
              <div className="flex items-center gap-2 mb-1">
                <Zap size={14} className={card.stripe_connected ? "text-green-600" : "text-amber-600"} />
                <span className={`text-sm font-semibold ${card.stripe_connected ? "text-green-700" : "text-amber-700"}`}>
                  {card.stripe_connected ? "Stripe connected" : "Stripe connection needed"}
                </span>
              </div>
              {!card.stripe_connected && (
                <div className="space-y-2">
                  {card.stripe_link_sent_at && (
                    <p className="text-xs text-amber-700">
                      Link generated {fmtDate(card.stripe_link_sent_at)}
                      {card.stripe_link_sent_by ? ` by ${card.stripe_link_sent_by}` : ""}
                    </p>
                  )}
                  {stripeUrl ? (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-amber-800">Connect link (send to client):</p>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={stripeUrl}
                          className="flex-1 text-xs font-mono bg-white border border-amber-200 rounded px-2 py-1 truncate"
                        />
                        <button
                          onClick={() => navigator.clipboard.writeText(stripeUrl)}
                          className="text-xs font-semibold text-amber-700 hover:text-amber-900 whitespace-nowrap"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => act("/request-stripe")}
                      disabled={acting}
                      className="text-xs font-semibold text-amber-700 hover:text-amber-900 flex items-center gap-1 disabled:opacity-50"
                    >
                      {acting ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                      {card.stripe_request_sent_at ? "Resend connect link" : "Generate connect link"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* BS Cleanup tools — quick links into the recovery toolkit when
              the bookkeeper is actively working a cleanup card. */}
          {stage === "bs_cleanup" && (
            <div>
              <p className="text-xs font-bold text-ink-slate uppercase tracking-wider mb-2">
                Cleanup tools
              </p>
              <div className="space-y-1.5">
                <Link
                  href={`/balance-sheet/${card.id}/ar-recovery`}
                  className="flex items-center gap-2 px-3 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg text-sm text-amber-900 font-semibold transition-colors"
                >
                  <Wallet size={14} />
                  <span className="flex-1">A/R Recovery</span>
                  <ArrowRight size={12} className="text-amber-700" />
                </Link>
                <Link
                  href={`/balance-sheet/${card.id}/coa`}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs text-navy"
                >
                  <span className="flex-1">BS COA viewer · AI BS cleanup</span>
                  <ArrowRight size={12} className="text-ink-slate" />
                </Link>
              </div>
            </div>
          )}

          {/* Stage actions */}
          {stage === "review" && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-ink-slate uppercase tracking-wider">Next step</p>
              <button
                onClick={() => act("/close-cleanup")}
                disabled={acting}
                className="w-full bg-teal hover:bg-teal-dark text-white text-sm font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Close cleanup — move to month-over-month
              </button>
              {actionMsg && <p className="text-xs text-red-600">{actionMsg}</p>}
            </div>
          )}

          {stage === "review_send" && card.latest_reclass_job && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-ink-slate uppercase tracking-wider">Next step</p>
              <button
                onClick={() => act("/close-month", { reclass_job_id: card.latest_reclass_job!.id })}
                disabled={acting}
                className="w-full bg-teal hover:bg-teal-dark text-white text-sm font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Mark month closed
              </button>
              {actionMsg && <p className="text-xs text-red-600">{actionMsg}</p>}
            </div>
          )}

          {/* Assign bookkeeper */}
          {canEdit && (
            <div>
              <p className="text-xs font-bold text-ink-slate uppercase tracking-wider mb-2">Assigned bookkeeper</p>
              <select
                defaultValue={card.bookkeeper?.id || ""}
                onChange={(e) => assignBookkeeper(e.target.value || null)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-navy focus:outline-none focus:border-teal"
              >
                <option value="">— Unassigned —</option>
                {bookkeepers.map((bk) => (
                  <option key={bk.id} value={bk.id}>{bk.full_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Client comms — manual checkboxes for outbound communications.
              We can detect that the artifact exists (email body generated,
              Stripe Connect token issued) but can't observe whether the
              bookkeeper actually sent it; these checkboxes are the source
              of truth. Idempotent via /comms-tracker. */}
          <div>
            <p className="text-xs font-bold text-ink-slate uppercase tracking-wider mb-2">
              Client comms
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-navy hover:text-teal-dark">
                <input
                  type="checkbox"
                  checked={askSent}
                  disabled={!canEdit || togglingField === "ask_client_sent"}
                  onChange={(e) => toggleCommsSent("ask_client_sent", e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-teal focus:ring-teal cursor-pointer disabled:opacity-50"
                />
                <span className={askSent ? "line-through text-ink-light" : ""}>
                  Sent client request to identify transactions
                </span>
                {togglingField === "ask_client_sent" && (
                  <Loader2 size={12} className="animate-spin text-ink-slate" />
                )}
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-navy hover:text-teal-dark">
                <input
                  type="checkbox"
                  checked={stripeReqSent}
                  disabled={!canEdit || togglingField === "stripe_request_sent"}
                  onChange={(e) => toggleCommsSent("stripe_request_sent", e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-teal focus:ring-teal cursor-pointer disabled:opacity-50"
                />
                <span className={stripeReqSent ? "line-through text-ink-light" : ""}>
                  Sent client stripe request
                </span>
                {togglingField === "stripe_request_sent" && (
                  <Loader2 size={12} className="animate-spin text-ink-slate" />
                )}
              </label>

              {card.cleanup_pdf_href && (
                <a
                  href={card.cleanup_pdf_href}
                  download
                  className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-teal hover:text-teal-dark"
                >
                  <Download size={13} />
                  Download Cleanup PDF
                </a>
              )}
            </div>
          </div>

          {/* Quick links */}
          <div>
            <p className="text-xs font-bold text-ink-slate uppercase tracking-wider mb-2">Quick links</p>
            <div className="space-y-1">
              <a
                href={`/clients`}
                className="flex items-center gap-2 text-sm text-teal hover:text-teal-dark"
              >
                <ExternalLink size={13} /> Client profile
              </a>
              {card.latest_reclass_job && (
                <a
                  href={`/reclass/${card.latest_reclass_job.id}/review`}
                  className="flex items-center gap-2 text-sm text-teal hover:text-teal-dark"
                >
                  <ExternalLink size={13} /> Latest reclass job
                </a>
              )}
              {card.latest_coa_job && (
                <a
                  href={`/jobs/${card.latest_coa_job.id}/review`}
                  className="flex items-center gap-2 text-sm text-teal hover:text-teal-dark"
                >
                  <ExternalLink size={13} /> Latest COA job
                </a>
              )}
            </div>
          </div>

          {/* Notes */}
          <div>
            <p className="text-xs font-bold text-ink-slate uppercase tracking-wider mb-3">
              Notes {notes.length > 0 && `(${notes.length})`}
            </p>

            {/* Add note */}
            <div className="bg-gray-50 rounded-xl p-3 mb-3 border border-gray-100">
              <textarea
                ref={textareaRef}
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Add a note..."
                rows={2}
                className="w-full text-sm bg-transparent outline-none resize-none text-navy placeholder:text-ink-light"
              />
              <div className="flex items-center justify-between mt-2 gap-2">
                <div className="flex items-center gap-1.5">
                  <Bell size={12} className="text-ink-slate" />
                  <input
                    type="date"
                    value={reminderAt}
                    onChange={(e) => setReminderAt(e.target.value)}
                    className="text-xs text-ink-slate bg-transparent outline-none"
                    title="Set reminder date"
                  />
                </div>
                <button
                  onClick={addNote}
                  disabled={savingNote || !newNote.trim()}
                  className="flex items-center gap-1.5 text-xs font-semibold text-white bg-teal hover:bg-teal-dark px-3 py-1.5 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {savingNote ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                  Add
                </button>
              </div>
            </div>

            {/* Notes list */}
            {loadingNotes ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={18} className="animate-spin text-ink-slate" />
              </div>
            ) : notes.length === 0 ? (
              <p className="text-xs text-ink-light text-center py-4">No notes yet</p>
            ) : (
              <div className="space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="bg-white border border-gray-100 rounded-xl p-3 group">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm text-navy leading-relaxed flex-1">{note.body}</p>
                      <button
                        onClick={() => deleteNote(note.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-ink-light hover:text-red-500 transition-all flex-shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[11px] text-ink-light">
                        {note.users?.full_name?.split(" ")[0] || "Unknown"} · {fmtDate(note.created_at)}
                      </span>
                      {note.reminder_at && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full">
                          <Bell size={9} />
                          {fmtDate(note.reminder_at)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
