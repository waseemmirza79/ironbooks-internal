"use client";

import { parseEntryMeta, type UfEntryMeta } from "@/lib/cleanup-system/entry-meta";
import { CheckCircle2, AlertCircle, XCircle, Clock, Loader2 } from "lucide-react";

/**
 * Plain-English label for each entry_type that lands in a proposed_entries
 * row. Bookkeepers shouldn't have to translate "receive_payment" in their
 * head — say what the action actually does.
 */
function entryActionLabel(entryType: string): string {
  switch (entryType) {
    case "receive_payment":
      return "Apply payment";
    case "void":
      return "Void invoice";
    case "reclass":
      return "Reclassify";
    case "journal_entry":
      return "Journal entry";
    case "bill_payment":
      return "Pay bill";
    case "invoice":
      return "Create invoice";
    default:
      return entryType;
  }
}

/**
 * Plain-English label for the decision state. The DB stores the raw enum
 * (auto_approve / needs_review / flagged / skip / approved) which mixes
 * tense and isn't friendly. This translates to what the bookkeeper sees.
 */
function decisionPill(decision: string, executed: boolean) {
  if (executed) {
    return {
      label: "Posted to QuickBooks",
      icon: CheckCircle2,
      className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    };
  }
  switch (decision) {
    case "approved":
      return {
        label: "Approved — ready to post",
        icon: CheckCircle2,
        className: "bg-green-100 text-green-700 border-green-200",
      };
    case "auto_approve":
      return {
        label: "Auto-approved",
        icon: CheckCircle2,
        className: "bg-emerald-50 text-emerald-700 border-emerald-200",
      };
    case "needs_review":
      return {
        label: "Needs your eye",
        icon: Clock,
        className: "bg-amber-50 text-amber-700 border-amber-200",
      };
    case "flagged":
      return {
        label: "Flagged",
        icon: AlertCircle,
        className: "bg-red-50 text-red-700 border-red-200",
      };
    case "skip":
      return {
        label: "Skipping",
        icon: XCircle,
        className: "bg-gray-100 text-gray-600 border-gray-200",
      };
    default:
      return {
        label: decision,
        icon: Clock,
        className: "bg-gray-100 text-gray-700 border-gray-200",
      };
  }
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export function ProposedEntryRow({
  entry,
  onApprove,
  onOverrideInvoice,
  posting,
}: {
  entry: any;
  onApprove: (id: string) => void;
  onOverrideInvoice: (id: string, invoiceId: string, docNumber: string) => void;
  posting?: boolean;
}) {
  const meta = parseEntryMeta(entry.ai_reasoning);

  // Full journal-entry breakdown (debit/credit lines + accounts). je_lines is
  // already on the row from GET /proposed; we just surface it so the bookkeeper
  // can see exactly what will hit QuickBooks before approving.
  const jeLines: any[] = Array.isArray(entry.je_lines) ? entry.je_lines : [];
  const jeDebitTotal = jeLines
    .filter((l) => l.side === "debit")
    .reduce((s, l) => s + Number(l.amount || 0), 0);
  const jeCreditTotal = jeLines
    .filter((l) => l.side !== "debit")
    .reduce((s, l) => s + Number(l.amount || 0), 0);
  const jeBalanced = Math.abs(jeDebitTotal - jeCreditTotal) < 0.005;
  const ufMeta = meta?.type === "uf_match" ? (meta as UfEntryMeta) : null;
  const arMeta = meta?.type === "ar_duplicate" ? meta : null;

  const amount = Number(entry.amount || 0);
  const action = entryActionLabel(entry.entry_type);

  // Build the human-readable headline. UF gets "Apply $500 to Invoice
  // #1234"; AR dup gets "Void duplicate of Invoice #5"; everything else
  // falls back to "<Action> · $amount".
  let headline: string;
  if (ufMeta) {
    const inv = ufMeta.candidates.find(
      (c) =>
        c.qbo_invoice_id === entry.bookkeeper_override_target_id ||
        c.qbo_invoice_id === ufMeta.proposed_invoice_id
    );
    const target = inv
      ? `Invoice #${inv.doc_number || inv.qbo_invoice_id}${inv.customer_name ? ` (${inv.customer_name})` : ""}`
      : ufMeta.proposed_invoice_id
      ? `Invoice ${ufMeta.proposed_invoice_id}`
      : "(pick an invoice)";
    headline = `Apply ${formatMoney(amount)} → ${target}`;
  } else if (arMeta) {
    headline = `Void duplicate of Invoice #${arMeta.survivor_doc_number || arMeta.survivor_invoice_id}`;
  } else {
    headline = `${action} · ${formatMoney(amount)}`;
  }

  // Match-quality micro-pill for UF rows so the bookkeeper sees confidence
  // signal without having to expand the entry.
  const kindBadge = (() => {
    if (ufMeta?.kind === "exact_invoice_number")
      return { label: "Exact match", className: "bg-emerald-100 text-emerald-700" };
    if (ufMeta?.kind === "high_confidence")
      return { label: "High confidence", className: "bg-teal/15 text-teal-dark" };
    if (ufMeta?.kind === "low_confidence")
      return { label: "Needs you to pick", className: "bg-amber-100 text-amber-800" };
    if (ufMeta?.kind === "unmatched")
      return { label: "No match found", className: "bg-red-100 text-red-800" };
    if (arMeta) return { label: "Duplicate invoice", className: "bg-rose-100 text-rose-800" };
    return null;
  })();

  const selectedInvoice =
    entry.bookkeeper_override_target_id ||
    entry.to_account_id ||
    ufMeta?.proposed_invoice_id;

  const decision = decisionPill(entry.decision, !!entry.executed);
  const DecisionIcon = decision.icon;

  // Disable approve when UF row has no invoice picked yet — posting
  // without a target would 400 from QBO and confuse the bookkeeper.
  const approveDisabled = !!ufMeta && !selectedInvoice;
  const canApprove =
    entry.decision !== "approved" &&
    entry.decision !== "skip" &&
    !entry.executed;

  return (
    <div className="p-4 rounded-xl border border-gray-200 hover:border-teal/40 transition-colors bg-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Headline + kind */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold text-navy text-sm">{headline}</span>
            {kindBadge && (
              <span
                className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${kindBadge.className}`}
              >
                {kindBadge.label}
              </span>
            )}
          </div>

          {/* Why this was proposed (matcher reasoning) */}
          {entry.memo && (
            <div className="text-xs text-ink-slate mt-0.5">{entry.memo}</div>
          )}
          {!entry.memo && meta && "reasoning" in meta && (
            <div className="text-xs text-ink-slate mt-0.5">{meta.reasoning}</div>
          )}

          {/* Invoice picker for UF rows — bookkeeper override of the matcher */}
          {ufMeta && ufMeta.candidates.length > 0 && (
            <div className="mt-2.5">
              <label className="text-[10px] font-bold text-ink-slate uppercase tracking-wider">
                Apply to which invoice?
              </label>
              <select
                className="mt-1 w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:border-teal focus:ring-1 focus:ring-teal/30 outline-none"
                value={selectedInvoice || ""}
                onChange={(e) => {
                  const opt = e.target.selectedOptions[0];
                  onOverrideInvoice(
                    entry.id,
                    e.target.value,
                    opt?.text || "Invoice"
                  );
                }}
              >
                <option value="">— Choose an invoice —</option>
                {ufMeta.candidates.map((c) => (
                  <option key={c.qbo_invoice_id} value={c.qbo_invoice_id}>
                    #{c.doc_number || c.qbo_invoice_id} ·{" "}
                    {formatMoney(c.balance)} ·{" "}
                    {c.customer_name || "(no customer)"}
                  </option>
                ))}
              </select>
              {ufMeta.candidates.length > 1 && (
                <div className="text-[10px] text-ink-light mt-1">
                  {ufMeta.candidates.length} possible invoices —{" "}
                  {ufMeta.kind === "low_confidence"
                    ? "pick the right one before approving"
                    : "matcher's pick shown, change if wrong"}
                </div>
              )}
            </div>
          )}

          {/* AR dupe survivor context */}
          {arMeta && (
            <div className="mt-1.5 text-xs text-ink-slate">
              Survivor (kept): Invoice #
              {arMeta.survivor_doc_number || arMeta.survivor_invoice_id}
            </div>
          )}

          {/* Full journal-entry breakdown — exactly what posts to QuickBooks */}
          {jeLines.length > 0 && (
            <div className="mt-2.5 rounded-lg border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[1fr_5rem_5rem] gap-x-2 px-3 py-1.5 bg-gray-50 text-[10px] font-bold uppercase tracking-wider text-ink-slate">
                <span>Account</span>
                <span className="text-right">Debit</span>
                <span className="text-right">Credit</span>
              </div>
              {jeLines.map((l, i) => {
                const acct =
                  l.qbo_account_name || l.account_name || l.account_hint || "(unresolved account)";
                const isDebit = l.side === "debit";
                const amt = Number(l.amount || 0);
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_5rem_5rem] gap-x-2 px-3 py-1.5 text-xs border-t border-gray-100"
                  >
                    <span className="text-navy min-w-0">
                      <span className="font-medium">{acct}</span>
                      {l.description && (
                        <span className="text-ink-light"> · {l.description}</span>
                      )}
                    </span>
                    <span className="text-right tabular-nums text-navy">
                      {isDebit ? formatMoney(amt) : ""}
                    </span>
                    <span className="text-right tabular-nums text-navy">
                      {!isDebit ? formatMoney(amt) : ""}
                    </span>
                  </div>
                );
              })}
              <div className="grid grid-cols-[1fr_5rem_5rem] gap-x-2 px-3 py-1.5 text-xs border-t border-gray-200 bg-gray-50 font-bold">
                <span className="text-ink-slate">Total</span>
                <span className="text-right tabular-nums text-navy">{formatMoney(jeDebitTotal)}</span>
                <span className="text-right tabular-nums text-navy">{formatMoney(jeCreditTotal)}</span>
              </div>
              {!jeBalanced && (
                <div className="px-3 py-1.5 text-[11px] text-red-700 bg-red-50 border-t border-red-200 flex items-center gap-1">
                  <AlertCircle size={11} /> Debits and credits don&apos;t balance — QuickBooks will
                  reject this until it does.
                </div>
              )}
            </div>
          )}

          {/* State + confidence + execution result */}
          <div className="flex items-center gap-2 mt-2.5">
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border ${decision.className}`}
            >
              <DecisionIcon size={11} />
              {decision.label}
            </span>
            {entry.confidence != null && (
              <span className="text-[10px] text-ink-light">
                {Math.round(Number(entry.confidence) * 100)}% confidence
              </span>
            )}
          </div>

          {entry.execution_error && (
            <div className="mt-2 px-2 py-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-red-800 leading-snug">
              <strong>Post failed:</strong> {entry.execution_error}
            </div>
          )}
        </div>

        {/* Approve CTA — approving posts the entry to QuickBooks immediately. */}
        {canApprove && (
          <button
            onClick={() => onApprove(entry.id)}
            disabled={approveDisabled || posting}
            title={
              approveDisabled
                ? "Pick an invoice first"
                : "Approve — posts this entry to QuickBooks now"
            }
            className="text-xs font-bold px-3 py-1.5 rounded-lg border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0 inline-flex items-center gap-1.5"
          >
            {posting ? <Loader2 size={12} className="animate-spin" /> : null}
            {posting ? "Posting…" : "Approve & post"}
          </button>
        )}
      </div>
    </div>
  );
}
