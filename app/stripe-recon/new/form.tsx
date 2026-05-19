"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Loader2, AlertCircle, Calendar, CreditCard, ArrowRight,
} from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  stripe_connection_status?: string | null;
}

interface DateRangePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

export function NewStripeReconForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [clientLinkId, setClientLinkId] = useState<string>("");
  const [reclassJobId, setReclassJobId] = useState<string | null>(null);
  const [extendingFromJobId, setExtendingFromJobId] = useState<string | null>(null);

  const [datePresetId, setDatePresetId] = useState<string>("fy");
  const [datePresets, setDatePresets] = useState<DateRangePreset[]>([]);
  const [fiscalYearStartMonthName, setFiscalYearStartMonthName] = useState<string>("");
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [presetsError, setPresetsError] = useState<string>("");

  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  // When the user lands here via the "extend" flow from a 0-deposit recon,
  // we honor start/end from the URL and skip the auto-preset overwrite that
  // would otherwise clobber them when datePresets finish loading.
  const [prefilledFromUrl, setPrefilledFromUrl] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>("");
  // When the API responds 409 with an existing_job_id, we hold it here so
  // the form can swap its generic error block for an actionable conflict
  // panel that links directly to the in-flight job.
  const [conflict, setConflict] = useState<{
    jobId: string;
    status: string;
  } | null>(null);

  const selectedClient = clientLinks.find((c) => c.id === clientLinkId);
  const isStripeConnected =
    selectedClient?.stripe_connection_status === "connected";

  // Default to Stripe API when connected, QBO matching otherwise. The user
  // can override on the form.
  const [method, setMethod] = useState<"stripe_api" | "qbo_invoice_match">(
    "qbo_invoice_match"
  );
  useEffect(() => {
    setMethod(isStripeConnected ? "stripe_api" : "qbo_invoice_match");
  }, [isStripeConnected]);

  // Auto-init from query string (handoff from reclass, or from the
  // "extend" CTA on a 0-deposit recon review).
  useEffect(() => {
    const cId = searchParams.get("client");
    const rId = searchParams.get("reclass_job_id");
    const sd = searchParams.get("start");
    const ed = searchParams.get("end");
    const ef = searchParams.get("extending_from");
    if (cId && clientLinks.some((c) => c.id === cId)) setClientLinkId(cId);
    if (rId) setReclassJobId(rId);
    if (ef) setExtendingFromJobId(ef);
    // Prefill start/end if provided. We mark prefilledFromUrl so the
    // "auto-default to FY preset when datePresets load" effect skips its
    // overwrite for this run.
    if (sd && ed) {
      setDateRangeStart(sd);
      setDateRangeEnd(ed);
      setPrefilledFromUrl(true);
    }
  }, [searchParams, clientLinks]);

  // Pre-check the same-client concurrency guard when a client is picked.
  // Catches the 409 case BEFORE submit so the form can disable itself and
  // show the conflict panel proactively — eliminates the "Failed to load
  // resource: 409" console errors that fire on the submit path.
  useEffect(() => {
    if (!clientLinkId) {
      setConflict(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/stripe-recon/active?client_link_id=${clientLinkId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.active) {
          setConflict({ jobId: data.active.id, status: data.active.status });
        } else {
          setConflict(null);
        }
      })
      .catch(() => {
        // Pre-check is best-effort; server-side guard still catches it.
      });
    return () => {
      cancelled = true;
    };
  }, [clientLinkId]);

  // Load fiscal year + presets when client is selected
  useEffect(() => {
    if (!clientLinkId) return;
    setLoadingPresets(true);
    setPresetsError("");
    fetch(`/api/clients/${clientLinkId}/company-info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load company info");
        return r.json();
      })
      .then((data) => {
        setDatePresets(data.date_range_presets);
        setFiscalYearStartMonthName(data.company.fiscal_year_start_month_name);
        // Only auto-apply the FY preset if we didn't get start/end from the
        // URL — otherwise we'd clobber the bookkeeper's "extend back" choice
        // the moment company-info finishes loading.
        if (!prefilledFromUrl) {
          const def = data.date_range_presets.find((p: DateRangePreset) => p.id === "fy")
                   || data.date_range_presets[0];
          if (def) {
            setDatePresetId(def.id);
            setDateRangeStart(def.start);
            setDateRangeEnd(def.end);
          }
        } else {
          // Mark as "custom" so the preset-switch effect below doesn't
          // overwrite the URL dates either.
          setDatePresetId("__custom__");
        }
      })
      .catch((e) => setPresetsError(e.message))
      .finally(() => setLoadingPresets(false));
  }, [clientLinkId]);

  useEffect(() => {
    const p = datePresets.find((p) => p.id === datePresetId);
    if (p) { setDateRangeStart(p.start); setDateRangeEnd(p.end); }
  }, [datePresetId, datePresets]);

  // Disable submit if the pre-check (or a prior 409) has identified an
  // active recon on this client. Belt-and-suspenders: the server guard
  // still rejects the submit if someone bypasses this, so safety isn't
  // dependent on the UI.
  const canSubmit =
    !!clientLinkId &&
    !!dateRangeStart &&
    !!dateRangeEnd &&
    !submitting &&
    !conflict;

  async function handleSubmit() {
    if (!canSubmit || !selectedClient) return;
    setSubmitting(true);
    setSubmitError("");
    setConflict(null);

    try {
      const res = await fetch("/api/stripe-recon/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          reclass_job_id: reclassJobId || undefined,
          date_range_start: dateRangeStart,
          date_range_end: dateRangeEnd,
          jurisdiction: selectedClient.jurisdiction,
          state_province: selectedClient.state_province || "",
          method,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 carries the existing job's id/status — render the actionable
        // conflict panel instead of dumping the prose into the error block.
        if (res.status === 409 && data.existing_job_id) {
          setConflict({
            jobId: data.existing_job_id,
            status: data.existing_status || "in_review",
          });
          setSubmitting(false);
          return;
        }
        throw new Error(data.error || "Failed to start job");
      }
      router.push(`/stripe-recon/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
        <div className="flex items-center gap-3">
          <CreditCard className="text-teal" size={24} />
          <h2 className="text-lg font-bold text-navy">Stripe AR Reconciliation</h2>
        </div>

        <p className="text-sm text-ink-slate">
          Pull Stripe deposits in a date range. AI matches each deposit to the customer
          invoices that make it up, calculates the Stripe processing fee
          {" "}(and sales tax on the fee for Canadian clients), and writes it back as
          labeled line items.
        </p>

        {reclassJobId && (
          <div className="p-3 rounded-lg bg-teal-lighter border border-teal/30 text-xs text-navy">
            ↪ Continuing from a transaction reclassification job.
          </div>
        )}

        {extendingFromJobId && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            ↪ Extending the search window — the previous recon found 0 Stripe
            deposits. Date range below is pre-filled to look one year further
            back.
          </div>
        )}

        {/* Client */}
        <div>
          <label className="block text-sm font-semibold text-navy mb-2">Client</label>
          <select
            value={clientLinkId}
            onChange={(e) => setClientLinkId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
          >
            <option value="">Select a client...</option>
            {clientLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name} ({c.jurisdiction}{c.state_province ? ` · ${c.state_province}` : ""}){c.stripe_connection_status === "connected" ? " · Stripe connected" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Matching method — only meaningful once a client is selected */}
        {clientLinkId && (
          <div>
            <label className="block text-sm font-semibold text-navy mb-2">
              Matching method
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!isStripeConnected}
                onClick={() => setMethod("stripe_api")}
                className={`px-3 py-3 rounded-lg border-2 text-left transition-colors ${
                  !isStripeConnected
                    ? "bg-gray-50 border-gray-200 cursor-not-allowed opacity-60"
                    : method === "stripe_api"
                    ? "bg-purple-50 border-purple-500 text-purple-900"
                    : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                }`}
              >
                <div className="font-semibold text-sm mb-1">
                  Stripe API {isStripeConnected ? "(deterministic)" : "(not connected)"}
                </div>
                <div className="text-[11px] leading-relaxed text-ink-slate">
                  {isStripeConnected
                    ? "Pull exact charges + fees from Stripe directly. No AI guessing — instant, accurate."
                    : "Send the client a Connect link from the sidebar to enable this method."}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setMethod("qbo_invoice_match")}
                className={`px-3 py-3 rounded-lg border-2 text-left transition-colors ${
                  method === "qbo_invoice_match"
                    ? "bg-teal-lighter border-teal text-teal"
                    : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                }`}
              >
                <div className="font-semibold text-sm mb-1">QBO invoice match (AI)</div>
                <div className="text-[11px] leading-relaxed text-ink-slate">
                  Match deposits to QBO invoices using AI. Falls back to a manual picker for any deposits the AI can't resolve.
                </div>
              </button>
            </div>
          </div>
        )}

        {clientLinkId && (
          <>
            {loadingPresets && (
              <div className="flex items-center gap-2 text-sm text-ink-slate">
                <Loader2 className="animate-spin" size={16} />
                Loading fiscal year from QuickBooks...
              </div>
            )}
            {presetsError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {presetsError}
              </div>
            )}

            {datePresets.length > 0 && (
              <div>
                <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
                  <Calendar size={14} /> Date Range
                </label>
                <div className="text-xs text-ink-slate mb-2">
                  Fiscal year starts in <span className="font-semibold">{fiscalYearStartMonthName}</span> (pulled from QBO)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {datePresets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setDatePresetId(p.id)}
                      className={`px-3 py-2.5 rounded-lg border-2 text-xs font-semibold text-left transition-colors ${
                        datePresetId === p.id
                          ? "bg-teal-lighter border-teal text-teal"
                          : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                      }`}
                    >
                      <div>{p.label}</div>
                      <div className="text-[10px] text-ink-light mt-0.5 font-normal">
                        {p.start} → {p.end}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Actionable conflict panel for the 409 same-client guard. The
            previous behavior dumped the prose error into the red block
            and made the bookkeeper hunt down the job by ID. Now the
            existing job is one click away. */}
        {conflict && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm space-y-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-amber-900">
                  A Stripe reconciliation is already in progress for{" "}
                  {selectedClient?.client_name || "this client"}.
                </div>
                <div className="text-xs text-amber-900 mt-1">
                  Status: <span className="font-semibold">{conflict.status}</span>.
                  Finish or close out the existing run before starting a new
                  one — same-client parallel runs cause deposit-snapshot
                  races.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() =>
                  router.push(`/stripe-recon/${conflict.jobId}/review`)
                }
                className="inline-flex items-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold px-3 py-1.5 rounded-md"
              >
                <ArrowRight size={13} />
                Open the existing recon
              </button>
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="text-xs font-semibold text-amber-900 hover:text-amber-950 px-2 py-1.5"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {submitError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {submitError}
          </div>
        )}

        {clientLinkId && (
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
            {submitting ? "Starting discovery..." : "Find Stripe deposits & match"}
          </button>
        )}
      </div>
    </div>
  );
}
