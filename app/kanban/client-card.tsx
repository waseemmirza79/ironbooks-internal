"use client";

import { useState } from "react";
import {
  MessageSquare, Clock, Zap, AlertCircle, CheckCircle2,
  Loader2, MoreHorizontal, PauseCircle, Download,
} from "lucide-react";
import type { KanbanCard } from "./types";

interface ClientCardProps {
  card: KanbanCard;
  stage: string;
  onOpen: (card: KanbanCard) => void;
  onRefresh: () => void;
  canEdit: boolean;
}

export function ClientCard({ card, stage, onOpen, onRefresh, canEdit }: ClientCardProps) {
  const [acting, setActing] = useState(false);

  const jobStatus = card.latest_reclass_job?.status || card.latest_coa_job?.status;
  const hasFailed = jobStatus === "failed";

  const daysSinceStripeRequest = card.stripe_request_sent_at
    ? Math.floor((Date.now() - new Date(card.stripe_request_sent_at).getTime()) / 86400000)
    : null;

  async function act(endpoint: string, body?: object) {
    setActing(true);
    try {
      await fetch(`/api/clients/${card.id}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      onRefresh();
    } finally {
      setActing(false);
    }
  }

  /**
   * Toggle one of the two "sent" comms-tracker checkboxes. Optimistic in
   * spirit (refresh after) but uses the existing /comms-tracker endpoint
   * which is idempotent — re-toggling the same value is a no-op.
   */
  async function toggleCommsSent(
    field: "ask_client_sent" | "stripe_request_sent",
    next: boolean
  ) {
    setActing(true);
    try {
      await fetch(`/api/clients/${card.id}/comms-tracker`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      onRefresh();
    } finally {
      setActing(false);
    }
  }

  const askClientSent = !!card.ask_client_email_sent_at;
  const stripeRequestSent = !!card.stripe_request_sent_confirmed_at;

  return (
    <div
      className="bg-white rounded-xl border border-gray-100 shadow-sm p-3.5 cursor-pointer hover:border-teal/40 hover:shadow-md transition-all group"
      onClick={() => onOpen(card)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-navy leading-tight truncate">
            {card.client_name}
          </div>
          <div className="text-xs text-ink-light mt-0.5">
            {card.jurisdiction}{card.state_province ? ` · ${card.state_province}` : ""}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(card); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-100 transition-all flex-shrink-0"
        >
          <MoreHorizontal size={14} className="text-ink-slate" />
        </button>
      </div>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
        {/* Stripe badge — only shown when detected, pending, or connected */}
        {card.stripe_detected && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
              card.stripe_connected
                ? "bg-green-50 text-green-700 border border-green-200"
                : card.stripe_pending
                ? "bg-blue-50 text-blue-700 border border-blue-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}
          >
            <Zap size={9} />
            {card.stripe_connected ? "Stripe ✓" : card.stripe_pending ? "Stripe pending" : "Stripe needed"}
          </span>
        )}

        {/* Failed job badge */}
        {hasFailed && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
            <AlertCircle size={9} />
            Job failed
          </span>
        )}

        {/* Due date */}
        {card.due_date && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-ink-slate">
            <Clock size={9} />
            {card.due_date}
          </span>
        )}
      </div>

      {/* Awaiting stripe: days counter */}
      {stage === "awaiting_stripe" && daysSinceStripeRequest !== null && (
        <div
          className={`text-xs font-semibold mb-2.5 ${
            daysSinceStripeRequest >= 5 ? "text-red-600" : "text-amber-600"
          }`}
        >
          {daysSinceStripeRequest === 0
            ? "Request sent today"
            : `Waiting ${daysSinceStripeRequest}d`}
        </div>
      )}

      {/* Client comms checkboxes — bookkeeper attests these manually since
          we can't observe outbound email. Idempotent via /comms-tracker. */}
      <div
        className="space-y-1 mb-2 text-[11px] text-ink-slate"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="flex items-center gap-1.5 cursor-pointer hover:text-navy">
          <input
            type="checkbox"
            checked={askClientSent}
            disabled={!canEdit || acting}
            onChange={(e) => toggleCommsSent("ask_client_sent", e.target.checked)}
            className="h-3 w-3 rounded border-gray-300 text-teal focus:ring-teal cursor-pointer disabled:opacity-50"
          />
          <span className={askClientSent ? "line-through text-ink-light" : ""}>
            Sent client request to identify transactions
          </span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer hover:text-navy">
          <input
            type="checkbox"
            checked={stripeRequestSent}
            disabled={!canEdit || acting}
            onChange={(e) => toggleCommsSent("stripe_request_sent", e.target.checked)}
            className="h-3 w-3 rounded border-gray-300 text-teal focus:ring-teal cursor-pointer disabled:opacity-50"
          />
          <span className={stripeRequestSent ? "line-through text-ink-light" : ""}>
            Sent client stripe request
          </span>
        </label>
      </div>

      {/* One-click cleanup-PDF download. Visible whenever we have a range
          to feed the report; the href is built server-side so all the
          fallback logic lives in /api/kanban/onboarding. */}
      {card.cleanup_pdf_href && (
        <a
          href={card.cleanup_pdf_href}
          onClick={(e) => e.stopPropagation()}
          download
          className="flex items-center justify-center gap-1.5 mb-2 text-[11px] font-semibold text-teal hover:text-teal-dark border border-teal/30 hover:bg-teal/5 rounded-md py-1 transition-colors"
        >
          <Download size={11} />
          Download Cleanup PDF
        </a>
      )}

      {/* Footer: bookkeeper + notes */}
      <div className="flex items-center justify-between mt-1">
        {card.bookkeeper ? (
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-full bg-teal flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
              {card.bookkeeper.full_name.charAt(0)}
            </div>
            <span className="text-[11px] text-ink-slate truncate max-w-[90px]">
              {card.bookkeeper.full_name.split(" ")[0]}
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-ink-light italic">Unassigned</span>
        )}

        {card.note_count > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-ink-slate">
            <MessageSquare size={11} />
            {card.note_count}
          </div>
        )}
      </div>

      {/* Action button — rendered based on stage, stops click propagation */}
      <ActionButton
        stage={stage}
        card={card}
        acting={acting}
        canEdit={canEdit}
        onAct={act}
        onOpen={() => onOpen(card)}
      />
    </div>
  );
}

function ActionButton({
  stage, card, acting, canEdit, onAct, onOpen,
}: {
  stage: string;
  card: KanbanCard;
  acting: boolean;
  canEdit: boolean;
  onAct: (endpoint: string, body?: object) => void;
  onOpen: () => void;
}) {
  const btn = (label: string, onClick: () => void, variant: "primary" | "secondary" = "secondary") => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={acting}
      className={`mt-2.5 w-full text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50 ${
        variant === "primary"
          ? "bg-teal hover:bg-teal-dark text-white"
          : "border border-gray-200 hover:border-gray-300 text-ink-slate hover:text-navy bg-white"
      }`}
    >
      {acting ? <Loader2 size={11} className="animate-spin mx-auto" /> : label}
    </button>
  );

  if (stage === "needs_cleanup") {
    return btn("Start Cleanup →", () => window.location.href = `/jobs/new?client=${card.id}`, "primary");
  }

  if (stage === "coa_in_progress" && card.latest_coa_job) {
    return btn("Continue COA →", () => window.location.href = `/jobs/${card.latest_coa_job!.id}/review`);
  }

  if (stage === "reclass_in_progress") {
    if (card.latest_reclass_job) {
      return btn("Continue Reclass →", () => window.location.href = `/reclass/${card.latest_reclass_job!.id}/review`);
    }
    return btn("Start Reclass →", () => window.location.href = `/reclass/new?client=${card.id}`, "primary");
  }

  if (stage === "review") {
    return (
      <div className="mt-2.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          disabled={acting}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="w-full text-xs font-semibold py-1.5 px-3 rounded-lg bg-teal hover:bg-teal-dark text-white transition-colors disabled:opacity-50"
        >
          {acting ? <Loader2 size={11} className="animate-spin mx-auto" /> : "Close & Move to MoM →"}
        </button>
        {card.stripe_detected && !card.stripe_connected && (
          <button
            disabled={acting}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="w-full text-xs font-semibold py-1.5 px-3 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 bg-white transition-colors disabled:opacity-50"
          >
            Request Stripe Connection
          </button>
        )}
      </div>
    );
  }

  if (stage === "awaiting_stripe") {
    return btn("Resend Link", () => onOpen());
  }

  if (stage === "bs_cleanup") {
    // Continue if there's already a bank_recon_jobs row; otherwise
    // "Start BS Cleanup" (primary CTA — first thing to do). Always
    // expose the manual-done escape hatch so a bookkeeper who already
    // reconciled outside the app can skip the workflow.
    const inProgress = (card as any).bs_recon_in_progress;
    async function manualDone() {
      if (!confirm(
        "Mark balance sheet done manually and move this client to Monthly Bookkeeping?"
      )) return;
      // Reuses the same /complete-cleanup endpoint the senior-review path
      // uses. It falls back to the latest complete COA job's date range
      // when none is supplied, so the cleanup-PDF link still works after.
      onAct("/complete-cleanup", {
        note: "BS balance done manually — moved to monthly bookkeeping",
      });
    }
    return (
      <div className="mt-2.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          disabled={acting}
          onClick={(e) => {
            e.stopPropagation();
            window.location.href = `/balance-sheet/${card.id}`;
          }}
          className={`w-full text-xs font-semibold py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50 ${
            inProgress
              ? "border border-gray-200 hover:border-gray-300 text-ink-slate hover:text-navy bg-white"
              : "bg-teal hover:bg-teal-dark text-white"
          }`}
        >
          {acting
            ? <Loader2 size={11} className="animate-spin mx-auto" />
            : (inProgress ? "Continue BS Cleanup →" : "Start BS Cleanup →")}
        </button>
        <button
          disabled={acting}
          onClick={(e) => { e.stopPropagation(); manualDone(); }}
          className="w-full text-[11px] font-semibold py-1.5 px-3 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 bg-white transition-colors disabled:opacity-50"
        >
          BS Balance Done Manually — Move to Monthly Bookkeeping
        </button>
      </div>
    );
  }

  // MoM stages
  if (stage === "month_open") {
    return btn("Start This Month →", () => window.location.href = `/reclass/new?client=${card.id}`, "primary");
  }

  if (stage === "in_progress" && card.latest_reclass_job) {
    return btn("Continue →", () => window.location.href = `/reclass/${card.latest_reclass_job!.id}/review`);
  }

  if (stage === "review_send" && card.latest_reclass_job) {
    return btn("Close Month ✓", () => onOpen(), "primary");
  }

  return null;
}
