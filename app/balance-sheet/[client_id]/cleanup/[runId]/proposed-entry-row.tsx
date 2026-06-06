"use client";

import { parseEntryMeta, type UfEntryMeta } from "@/lib/cleanup-system/entry-meta";

export function ProposedEntryRow({
  entry,
  onApprove,
  onOverrideInvoice,
}: {
  entry: any;
  onApprove: (id: string) => void;
  onOverrideInvoice: (id: string, invoiceId: string, docNumber: string) => void;
}) {
  const meta = parseEntryMeta(entry.ai_reasoning);
  const ufMeta = meta?.type === "uf_match" ? (meta as UfEntryMeta) : null;

  const kindLabel =
    ufMeta?.kind === "exact_invoice_number"
      ? "Exact invoice #"
      : ufMeta?.kind === "high_confidence"
      ? "High confidence"
      : ufMeta?.kind === "low_confidence"
      ? "Needs pick"
      : ufMeta?.kind === "unmatched"
      ? "Unmatched"
      : meta?.type === "ar_duplicate"
      ? "Duplicate invoice"
      : entry.entry_type;

  const selectedInvoice =
    entry.bookkeeper_override_target_id ||
    entry.to_account_id ||
    ufMeta?.proposed_invoice_id;

  return (
    <div className="p-3 rounded-xl border border-gray-100 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-navy">
              {entry.entry_type} · ${Number(entry.amount || 0).toFixed(2)}
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-light bg-gray-100 px-1.5 py-0.5 rounded">
              {kindLabel}
            </span>
          </div>
          <div className="text-xs text-ink-light mt-0.5">
            {entry.memo || (meta && "reasoning" in meta ? meta.reasoning : entry.ai_reasoning)}
          </div>
          {ufMeta && ufMeta.candidates.length > 0 && (
            <div className="mt-2">
              <label className="text-[10px] font-semibold text-ink-slate uppercase tracking-wide">
                Apply to invoice
              </label>
              <select
                className="mt-1 w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5"
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
                <option value="">Select invoice…</option>
                {ufMeta.candidates.map((c) => (
                  <option key={c.qbo_invoice_id} value={c.qbo_invoice_id}>
                    #{c.doc_number || c.qbo_invoice_id} · ${c.balance.toFixed(2)} ·{" "}
                    {c.customer_name || "—"}
                  </option>
                ))}
              </select>
            </div>
          )}
          {meta?.type === "ar_duplicate" && (
            <div className="text-xs text-ink-slate mt-1">
              Keep survivor #{meta.survivor_doc_number || meta.survivor_invoice_id}
            </div>
          )}
          <div className="text-xs mt-1.5">
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                entry.decision === "approved"
                  ? "bg-green-100 text-green-700"
                  : entry.decision === "flagged"
                  ? "bg-red-100 text-red-700"
                  : entry.decision === "auto_approve"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {entry.decision}
            </span>
            {entry.confidence != null && (
              <span className="ml-2 text-ink-light">
                {Math.round(Number(entry.confidence) * 100)}% conf
              </span>
            )}
            {entry.executed && (
              <span className="ml-2 text-green-700 font-semibold">Posted ✓</span>
            )}
            {entry.execution_error && (
              <span className="ml-2 text-red-600">{entry.execution_error}</span>
            )}
          </div>
        </div>
        {entry.decision !== "approved" &&
          entry.decision !== "skip" &&
          !entry.executed && (
            <button
              onClick={() => onApprove(entry.id)}
              disabled={!!ufMeta && !selectedInvoice}
              className="text-xs font-semibold px-2 py-1 rounded border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-40"
            >
              Approve
            </button>
          )}
      </div>
    </div>
  );
}
