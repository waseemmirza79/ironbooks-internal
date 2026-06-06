"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2, RefreshCw, CheckCircle2, AlertCircle, XCircle,
  ArrowRight, Upload, Shield, FileText, Play,
} from "lucide-react";
import { MODULE_LABELS, type CleanupModule } from "@/lib/cleanup-system/types";
import { ProposedEntryRow } from "./proposed-entry-row";

type WizardStep = "diagnose" | "modules" | "review" | "qa" | "deliver";

interface RunStatus {
  run: any;
  modules: any[];
  health_score: any;
  counts: { proposed: number; pending_review: number };
  cpa_flags: any[];
}

const GRADE_COLORS = {
  green: "bg-green-100 text-green-800 border-green-200",
  yellow: "bg-amber-100 text-amber-800 border-amber-200",
  red: "bg-red-100 text-red-800 border-red-200",
};

const MODULE_STATUS_ICON: Record<string, any> = {
  complete: CheckCircle2,
  failed: XCircle,
  executing: Loader2,
  discovering: Loader2,
  reviewing: AlertCircle,
  ready: ArrowRight,
  locked: Shield,
};

export function CleanupWizardClient({
  clientLinkId,
  runId,
}: {
  clientLinkId: string;
  runId: string;
}) {
  const [step, setStep] = useState<WizardStep>("diagnose");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [entries, setEntries] = useState<any[]>([]);
  const [qa, setQa] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [csvSource, setCsvSource] = useState("stripe");
  const [csvText, setCsvText] = useState("");
  const [activeModule, setActiveModule] = useState<CleanupModule | null>(null);
  const [reviewTab, setReviewTab] = useState("needs_review");
  const [attested, setAttested] = useState(false);
  const [aiSummary, setAiSummary] = useState("");
  const [crmSource, setCrmSource] = useState<"jobber" | "drip_jobs" | "generic">("jobber");
  const [crmCsv, setCrmCsv] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/cleanup/${runId}/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const loadEntries = useCallback(async (module?: string, decision?: string) => {
    const params = new URLSearchParams();
    if (module) params.set("module", module);
    if (decision) params.set("decision", decision);
    const res = await fetch(`/api/cleanup/${runId}/proposed?${params}`);
    const data = await res.json();
    setEntries(data.entries || []);
  }, [runId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function importCsv() {
    if (!csvText.trim()) return;
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: csvSource, csv_text: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCsvText("");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function discoverModule(mod: CleanupModule) {
    setActing(true);
    setActiveModule(mod);
    try {
      const body: Record<string, string> = {};
      if (mod === "accounts_receivable" && crmCsv.trim()) {
        body.crm_source = crmSource;
        body.crm_csv_text = crmCsv;
      }
      const res = await fetch(`/api/cleanup/${runId}/modules/${mod}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep("review");
      setTimeout(() => loadEntries(mod), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function approveEntry(id: string) {
    await fetch(`/api/cleanup/${runId}/proposed/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    await loadEntries(activeModule || undefined, reviewTab);
  }

  async function approveAllAuto() {
    await fetch(`/api/cleanup/${runId}/proposed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_all_auto", module: activeModule }),
    });
    await loadEntries(activeModule || undefined);
  }

  async function approveUfConfident() {
    await fetch(`/api/cleanup/${runId}/proposed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_uf_confident" }),
    });
    await loadEntries("undeposited_funds", reviewTab);
  }

  async function overrideInvoice(
    entryId: string,
    invoiceId: string,
    docNumber: string
  ) {
    const entry = entries.find((e) => e.id === entryId);
    await fetch(`/api/cleanup/${runId}/proposed/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: entry?.decision || "needs_review",
        override_target_id: invoiceId,
        override_target_name: docNumber,
      }),
    });
    await loadEntries(activeModule || undefined, reviewTab);
  }

  async function executeModule(mod: CleanupModule) {
    if (!attested) {
      setError("Check the attestation box before executing QBO writes.");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/modules/${mod}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attested: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
      setStep("modules");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function runQA() {
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/qa`, { method: "POST" });
      const data = await res.json();
      setQa(data);
      setStep("qa");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function deliver(publish: boolean) {
    setActing(true);
    try {
      const res = await fetch(`/api/cleanup/${runId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publish_to_portal: publish,
          ai_summary: aiSummary,
          ai_summary_reviewed: !!aiSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "QA gate failed");
      setStep("deliver");
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActing(false);
    }
  }

  async function signOffFlag(flagId: string) {
    await fetch(`/api/cleanup/${runId}/cpa-flags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flag_id: flagId, action: "sign_off" }),
    });
    await refresh();
  }

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-teal" size={32} />
      </div>
    );
  }

  const hs = status?.health_score;
  const grade = hs?.overall_grade || "red";
  const score = hs?.overall_score ?? 0;

  const STEPS: { key: WizardStep; label: string }[] = [
    { key: "diagnose", label: "Diagnose" },
    { key: "modules", label: "Modules" },
    { key: "review", label: "Review" },
    { key: "qa", label: "QA Gate" },
    { key: "deliver", label: "Deliver" },
  ];

  return (
    <div className="space-y-6">
      {/* Step nav */}
      <div className="flex gap-2 flex-wrap">
        {STEPS.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              setStep(s.key);
              if (s.key === "review") loadEntries(activeModule || undefined);
            }}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
              step === s.key
                ? "bg-teal text-white border-teal"
                : "bg-white text-ink-slate border-gray-200 hover:border-teal/40"
            }`}
          >
            {s.label}
          </button>
        ))}
        <button onClick={refresh} className="ml-auto p-1.5 rounded-lg hover:bg-gray-100">
          <RefreshCw size={14} className="text-ink-slate" />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
          <button onClick={() => setError("")} className="ml-auto text-xs underline">dismiss</button>
        </div>
      )}

      {/* CPA flags banner */}
      {(status?.cpa_flags || []).filter((f) => f.status === "open").length > 0 && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200">
          <div className="font-semibold text-red-800 text-sm mb-2 flex items-center gap-2">
            <Shield size={14} />
            CPA flags — blocked until sign-off
          </div>
          {(status?.cpa_flags || [])
            .filter((f) => f.status === "open")
            .map((f) => (
              <div key={f.id} className="flex items-center justify-between text-sm text-red-700 py-1">
                <span>{f.description}</span>
                <button
                  onClick={() => signOffFlag(f.id)}
                  className="text-xs font-semibold px-2 py-1 rounded border border-red-300 hover:bg-red-100"
                >
                  Sign off
                </button>
              </div>
            ))}
        </div>
      )}

      {/* DIAGNOSE */}
      {step === "diagnose" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className={`rounded-2xl border p-6 text-center ${GRADE_COLORS[grade as keyof typeof GRADE_COLORS]}`}>
              <div className="text-5xl font-black mb-1">{score}</div>
              <div className="text-sm font-semibold uppercase tracking-wide">Health Score</div>
              <div className="text-xs mt-1 capitalize">{grade}</div>
            </div>
            <button
              onClick={() => setStep("modules")}
              className="w-full mt-4 bg-teal text-white font-semibold py-2.5 rounded-xl hover:bg-teal-dark transition-colors flex items-center justify-center gap-2"
            >
              Start fixing <ArrowRight size={14} />
            </button>
          </div>

          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-navy mb-3">Priority tasks</h3>
              <div className="space-y-2">
                {((hs?.task_list as any[]) || []).slice(0, 8).map((t: any) => (
                  <div key={t.id} className="flex items-start gap-2 text-sm">
                    <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      t.grade === "red" ? "bg-red-500" : "bg-amber-400"
                    }`} />
                    <div>
                      <div className="font-medium text-navy">{t.title}</div>
                      <div className="text-xs text-ink-light">{t.description}</div>
                    </div>
                  </div>
                ))}
                {(!hs?.task_list || (hs.task_list as any[]).length === 0) && (
                  <div className="text-sm text-green-700 flex items-center gap-2">
                    <CheckCircle2 size={14} /> No issues detected
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-semibold text-navy mb-3 flex items-center gap-2">
                <Upload size={14} /> Import CSVs (optional)
              </h3>
              <div className="flex gap-2 mb-2">
                {["stripe", "bank", "jobber", "drip_jobs", "loan_statement"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setCsvSource(s)}
                    className={`text-xs px-2 py-1 rounded border ${
                      csvSource === s ? "bg-teal text-white border-teal" : "border-gray-200"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="Paste CSV content here..."
                className="w-full h-24 text-xs font-mono border border-gray-200 rounded-lg p-2"
              />
              <button
                onClick={importCsv}
                disabled={acting || !csvText.trim()}
                className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-navy text-white disabled:opacity-50"
              >
                {acting ? <Loader2 size={12} className="animate-spin" /> : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODULES */}
      {step === "modules" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h3 className="font-semibold text-navy mb-2">Module checklist</h3>
          <p className="text-xs text-ink-light mb-4">
            Recommended order: Bank Recon → Undeposited Funds → Accounts Receivable.
            UF matching and duplicate voids post directly to QuickBooks on execute.
          </p>
          <div className="space-y-2">
            {(status?.modules || []).map((m: any) => {
              const Icon = MODULE_STATUS_ICON[m.status] || ArrowRight;
              const isReady = ["ready", "reviewing", "complete"].includes(m.status);
              return (
                <div key={m.module}>
                <div
                  className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-teal/30"
                >
                  <Icon
                    size={16}
                    className={`flex-shrink-0 ${
                      m.status === "complete" ? "text-green-600" :
                      m.status === "failed" ? "text-red-600" :
                      ["executing", "discovering"].includes(m.status) ? "animate-spin text-teal" :
                      "text-ink-slate"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-navy">
                      {MODULE_LABELS[m.module as CleanupModule] || m.module}
                    </div>
                    <div className="text-xs text-ink-light capitalize">
                      {m.status} · {m.proposed_count || 0} proposed · {m.executed_count || 0} executed
                    </div>
                  </div>
                  {isReady && m.status !== "complete" && (
                    <button
                      onClick={() => discoverModule(m.module)}
                      disabled={acting}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal text-white disabled:opacity-50"
                    >
                      {acting && activeModule === m.module ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : "Discover"}
                    </button>
                  )}
                  {m.status === "reviewing" && (
                    <button
                      onClick={() => {
                        setActiveModule(m.module);
                        setStep("review");
                        loadEntries(m.module);
                      }}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200"
                    >
                      Review
                    </button>
                  )}
                </div>
                {m.module === "accounts_receivable" && m.status !== "complete" && (
                  <div className="ml-9 mb-2 p-3 rounded-xl border border-amber-100 bg-amber-50/50">
                    <h4 className="text-xs font-semibold text-navy mb-2">
                      CRM export (optional — paste before Discover)
                    </h4>
                    <div className="flex gap-2 mb-2">
                      {(["jobber", "drip_jobs", "generic"] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => setCrmSource(s)}
                          className={`text-xs px-2 py-1 rounded border ${
                            crmSource === s ? "bg-teal text-white border-teal" : "border-gray-200"
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={crmCsv}
                      onChange={(e) => setCrmCsv(e.target.value)}
                      placeholder="Paste Jobber / DripJobs CSV for duplicate-invoice scan…"
                      className="w-full h-16 text-xs font-mono border border-gray-200 rounded-lg p-2"
                    />
                  </div>
                )}
                </div>
              );
            })}
          </div>

          <button
            onClick={runQA}
            disabled={acting}
            className="mt-4 w-full py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-navy hover:border-teal/40"
          >
            Run QA Gate
          </button>
        </div>
      )}

      {/* REVIEW */}
      {step === "review" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-navy">
              Review queue {activeModule ? `· ${MODULE_LABELS[activeModule]}` : ""}
            </h3>
            <div className="flex gap-2">
              {["auto_approve", "needs_review", "flagged", "skip", "approved"].map((tab) => (
                <button
                  key={tab}
                  onClick={() => { setReviewTab(tab); loadEntries(activeModule || undefined, tab); }}
                  className={`text-xs px-2 py-1 rounded border ${
                    reviewTab === tab ? "bg-navy text-white border-navy" : "border-gray-200"
                  }`}
                >
                  {tab.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={approveAllAuto}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white"
            >
              Approve all auto
            </button>
            {activeModule === "undeposited_funds" && (
              <button
                onClick={approveUfConfident}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal text-white"
              >
                Approve exact + high confidence
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-ink-slate ml-auto">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              I attest these entries are correct before posting to QBO
            </label>
          </div>

          <div className="space-y-2 max-h-96 overflow-y-auto">
            {entries.length === 0 && (
              <div className="text-sm text-ink-light py-8 text-center">
                No entries in this tab. Run Discover on a module first.
              </div>
            )}
            {entries.map((e) => (
              <ProposedEntryRow
                key={e.id}
                entry={e}
                onApprove={approveEntry}
                onOverrideInvoice={overrideInvoice}
              />
            ))}
          </div>

          {activeModule && (
            <button
              onClick={() => executeModule(activeModule)}
              disabled={acting || !attested}
              className="mt-4 w-full flex items-center justify-center gap-2 bg-navy text-white font-semibold py-3 rounded-xl disabled:opacity-50"
            >
              {acting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Execute approved entries
            </button>
          )}
        </div>
      )}

      {/* QA */}
      {step === "qa" && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h3 className="font-semibold text-navy mb-4 flex items-center gap-2">
            <Shield size={16} />
            QA Gate
          </h3>
          {!qa && (
            <button onClick={runQA} disabled={acting} className="text-sm font-semibold text-teal underline">
              Run QA check
            </button>
          )}
          {qa && (
            <div className="space-y-2">
              {(qa.checks || []).map((c: any) => (
                <div key={c.id} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100">
                  {c.passed ? (
                    <CheckCircle2 size={16} className="text-green-600" />
                  ) : (
                    <XCircle size={16} className="text-red-600" />
                  )}
                  <div>
                    <div className="text-sm font-medium text-navy">{c.label}</div>
                    <div className="text-xs text-ink-light">{c.detail}</div>
                  </div>
                </div>
              ))}
              {qa.passed ? (
                <div className="mt-4 space-y-3">
                  <textarea
                    value={aiSummary}
                    onChange={(e) => setAiSummary(e.target.value)}
                    placeholder="Plain-language summary for client (human-reviewed)..."
                    className="w-full h-24 text-sm border border-gray-200 rounded-lg p-3"
                  />
                  <button
                    onClick={() => deliver(true)}
                    disabled={acting}
                    className="w-full bg-teal text-white font-semibold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <FileText size={16} />
                    Deliver &amp; publish to portal
                  </button>
                </div>
              ) : (
                <div className="mt-4 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm">
                  QA gate failed — resolve issues above before delivering.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* DELIVER */}
      {step === "deliver" && status?.run?.status === "complete" && (
        <div className="bg-green-50 rounded-2xl border border-green-200 p-8 text-center">
          <CheckCircle2 size={40} className="text-green-600 mx-auto mb-3" />
          <h3 className="text-xl font-bold text-green-800 mb-2">Cleanup complete</h3>
          <p className="text-sm text-green-700 mb-4">
            Report published. You can now mark the client complete or submit for senior review.
          </p>
          <div className="flex gap-3 justify-center">
            <a
              href={`/balance-sheet/${clientLinkId}`}
              className="text-sm font-semibold px-4 py-2 rounded-lg border border-green-300 text-green-800 hover:bg-green-100"
            >
              Legacy BS tools
            </a>
            <button
              onClick={async () => {
                await fetch(`/api/clients/${clientLinkId}/complete-cleanup`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ note: `BS cleanup run ${runId} completed via wizard` }),
                });
                window.location.href = "/kanban";
              }}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-green-700 text-white hover:bg-green-800"
            >
              Mark cleanup complete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
