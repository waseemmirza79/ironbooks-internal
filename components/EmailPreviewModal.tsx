"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, Send, Mail, AlertCircle } from "lucide-react";

interface PreviewData {
  html: string;
  subject: string;
  recipients: string[];
  no_address: boolean;
  address_note?: string;
  client_name?: string;
}

/**
 * Reusable "review the branded email before it sends" modal. Fetches the
 * rendered email from a preview endpoint (so it's byte-identical to what's
 * sent), shows the recipient(s), and only sends on Confirm. Handles the
 * no-address-on-file case inline (enter an address → re-preview → send),
 * which the send route then persists to the client profile.
 */
export function EmailPreviewModal({
  title,
  previewUrl,
  onConfirm,
  onClose,
  confirmLabel = "Confirm & send",
}: {
  title: string;
  /** Preview endpoint URL (without override_email — the modal adds it). */
  previewUrl: string;
  /** Runs the real send. Receives the override address (or null). */
  onConfirm: (overrideEmail: string | null) => Promise<void>;
  onClose: () => void;
  confirmLabel?: string;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [overrideEmail, setOverrideEmail] = useState("");
  const [appliedOverride, setAppliedOverride] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  async function load(override?: string | null) {
    setLoading(true);
    setErr("");
    try {
      const u = new URL(previewUrl, window.location.origin);
      if (override) u.searchParams.set("override_email", override);
      const res = await fetch(u.toString(), { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not load preview");
      setData(d);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  async function confirm() {
    setConfirming(true);
    setErr("");
    try {
      await onConfirm(appliedOverride);
    } catch (e: any) {
      setErr(e.message || "Send failed");
      setConfirming(false);
    }
  }

  if (!mounted) return null;

  const canSend = !!data && !data.no_address && data.recipients.length > 0;

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(15,31,46,0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <Mail size={18} className="text-teal" /> {title}
            </h3>
            <p className="text-xs text-ink-slate mt-1">Review the email below — it sends only when you confirm.</p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-ink-slate py-8 justify-center">
              <Loader2 className="animate-spin" size={16} /> Loading preview…
            </div>
          ) : (
            <>
              {data?.subject && (
                <div className="text-sm">
                  <span className="text-ink-light">Subject: </span>
                  <span className="font-semibold text-navy">{data.subject}</span>
                </div>
              )}

              {/* Recipient / no-address */}
              {data?.no_address ? (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-900">
                    <AlertCircle size={14} /> No email on file for this client
                  </div>
                  {data.address_note && <p className="text-[11px] text-amber-800">{data.address_note}</p>}
                  <p className="text-[11px] text-amber-800">Enter an address — we&apos;ll preview + send there and save it to the profile.</p>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={overrideEmail}
                      onChange={(e) => setOverrideEmail(e.target.value)}
                      placeholder="owner@client.com"
                      className="flex-1 px-3 py-2 rounded-lg border border-amber-300 text-sm text-navy outline-none focus:border-amber-500"
                    />
                    <button
                      type="button"
                      onClick={() => { setAppliedOverride(overrideEmail.trim()); load(overrideEmail.trim()); }}
                      disabled={!overrideEmail.trim()}
                      className="inline-flex items-center gap-1.5 bg-navy hover:bg-ink-light disabled:opacity-50 text-white text-[13px] font-semibold px-3 py-2 rounded-lg whitespace-nowrap"
                    >
                      Preview to this address
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm">
                  <span className="text-ink-light">To: </span>
                  <span className="font-semibold text-navy">{data?.recipients.join(", ")}</span>
                </div>
              )}

              {data?.html && (
                <iframe
                  title="Email preview"
                  srcDoc={data.html}
                  sandbox=""
                  className="w-full h-80 rounded-lg border border-gray-200 bg-white"
                />
              )}

              {err && <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-[12px] text-red-800">{err}</div>}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button onClick={onClose} className="text-sm font-semibold text-ink-slate hover:text-navy">Cancel</button>
          <button
            onClick={confirm}
            disabled={!canSend || confirming}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            {confirming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {confirming ? "Sending…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
