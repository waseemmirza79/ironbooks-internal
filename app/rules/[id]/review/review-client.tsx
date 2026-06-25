"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Flag, Loader2, ArrowRight, AlertTriangle, Zap, DollarSign, Download, Undo2 } from "lucide-react";
import type { Database } from "@/lib/database.types";

type Rule = Database["public"]["Tables"]["bank_rules"]["Row"];
type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

type CoaAccount = {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
};

export function RulesReviewClient({
  jobId,
  clientLink,
  initialRules,
  jobStatus,
  reclassByVendor = {},
}: {
  jobId: string;
  clientLink: ClientLink;
  initialRules: Rule[];
  jobStatus: string;
  reclassByVendor?: Record<string, string>;
}) {
  const router = useRouter();
  const [rules, setRules] = useState(initialRules);
  const [executing, setExecuting] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected" | "flagged">("all");

  // Full chart of accounts for this client — powers the per-rule target
  // account picker so the bookkeeper can retarget a rule to ANY account, not
  // just the AI/reclass default. Fetched once on mount; the picker degrades to
  // plain text until it loads (or if QBO is unreachable).
  const [accounts, setAccounts] = useState<CoaAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setAccountsLoading(true);
    fetch(`/api/clients/${clientLink.id}/qbo-accounts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.accounts) setAccounts(d.accounts as CoaAccount[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientLink.id]);

  const counts = {
    pending: rules.filter((r) => r.status === "pending").length,
    approved: rules.filter((r) => r.status === "approved").length,
    rejected: rules.filter((r) => r.status === "rejected").length,
    flagged: rules.filter((r) => r.requires_approval).length,
  };

  // Export stats — populated lazily after mount so we don't block initial
  // render. Powers the "X new since last export" badge on the download
  // button so Lisa can tell at a glance whether the .xls will be a no-op
  // or a meaningful incremental.
  const [exportStats, setExportStats] = useState<{
    total_active: number;
    never_exported: number;
    last_exported_at: string | null;
  } | null>(null);

  useEffect(() => {
    if (!jobStatus || jobStatus !== "complete") return;
    let cancelled = false;
    fetch(`/api/rules/export-qbo/${clientLink.id}/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setExportStats(d);
      })
      .catch(() => {}); // non-critical; UI gracefully omits the badge
    return () => {
      cancelled = true;
    };
  }, [jobStatus, clientLink.id]);

  const filtered = rules.filter((r) => {
    if (filter === "all") return true;
    if (filter === "flagged") return r.requires_approval;
    return r.status === filter;
  });

  async function updateRule(id: string, updates: Partial<Rule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));

    await fetch(`/api/rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  }

  async function bulkApprove() {
    const highConfidence = rules.filter(
      (r) => r.status === "pending" && !r.requires_approval && (r.ai_confidence || 0) >= 0.9
    );
    if (highConfidence.length === 0) {
      alert("No high-confidence non-flagged rules to bulk-approve.");
      return;
    }
    if (!confirm(`Auto-approve the ${highConfidence.length} highest-confidence rules? You can still edit any of them after. (Skipping rules that need review.)`)) {
      return;
    }

    await Promise.all(
      highConfidence.map((r) =>
        fetch(`/api/rules/${r.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved" }),
        })
      )
    );

    setRules((prev) =>
      prev.map((r) =>
        highConfidence.find((h) => h.id === r.id) ? { ...r, status: "approved" } : r
      )
    );
  }

  async function executeApproved() {
    if (counts.approved === 0) {
      alert("Approve at least one rule first.");
      return;
    }

    if (!confirm(`Activate ${counts.approved} approved rules for ${clientLink.client_name}? SNAP will start applying them to new transactions and posting categorizations to QBO automatically.`)) {
      return;
    }

    setExecuting(true);
    const res = await fetch("/api/rules/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discovery_job_id: jobId }),
    });

    const result = await res.json();
    setExecuting(false);

    if (result.success) {
      alert(`✓ ${result.activated ?? result.pushed} rules activated in SNAP. Download the .xls below if you also want them in QBO's native Rules tab.`);
      router.refresh();
    } else {
      alert(`Activated ${result.pushed ?? 0}, failed ${result.failed ?? 0}:\n${result.errors?.join("\n") || result.error}`);
    }
  }

  const isComplete = jobStatus === "complete";

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <Stat label="Total Rules" value={rules.length} color="#0F1F2E" />
        <Stat label="Approved" value={counts.approved} color="#10B981" />
        <Stat label="Pending" value={counts.pending} color="#F59E0B" />
        <Stat label="Need Review" value={counts.flagged} color="#DC2626" />
      </div>

      {isComplete && (
        <div className="rounded-xl p-4 mb-5 bg-green-50 border border-green-200">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Check size={20} className="text-green-600 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-bold text-sm text-navy">Rules active in SNAP</h3>
                <p className="text-xs text-ink-slate">
                  SNAP applies these rules to new transactions and posts the categorization to QBO.
                  Want them in QBO&apos;s native Rules tab too? Download below and import.
                </p>
                {exportStats && (
                  <p className="text-[11px] text-ink-slate mt-1.5">
                    {exportStats.never_exported > 0 ? (
                      <>
                        <span className="font-semibold text-emerald-700">
                          {exportStats.never_exported} new rule
                          {exportStats.never_exported === 1 ? "" : "s"}
                        </span>
                        {" "}since last export
                        {exportStats.last_exported_at && (
                          <>
                            {" "}({new Date(exportStats.last_exported_at).toLocaleDateString()})
                          </>
                        )}
                        {" · "}
                        <a
                          href={`/api/rules/export-qbo/${clientLink.id}?include=all`}
                          download
                          className="underline hover:text-teal"
                          title="Re-export everything, including rules already in QBO. Use only if you wiped QBO's Rules tab or set up a new QBO file."
                        >
                          re-export all {exportStats.total_active}
                        </a>
                      </>
                    ) : exportStats.total_active > 0 ? (
                      <>
                        All {exportStats.total_active} rule
                        {exportStats.total_active === 1 ? "" : "s"} already exported
                        {exportStats.last_exported_at && (
                          <> ({new Date(exportStats.last_exported_at).toLocaleDateString()})</>
                        )}
                        {" · "}
                        <a
                          href={`/api/rules/export-qbo/${clientLink.id}?include=all`}
                          download
                          className="underline hover:text-teal"
                          title="Re-export everything. Use only if you wiped QBO's Rules tab or set up a new QBO file."
                        >
                          re-export anyway
                        </a>
                      </>
                    ) : null}
                  </p>
                )}
              </div>
            </div>
            <a
              href={`/api/rules/export-qbo/${clientLink.id}`}
              download
              className={`shrink-0 inline-flex items-center gap-2 text-xs font-semibold border px-3 py-2 rounded-lg transition-colors ${
                exportStats && exportStats.never_exported === 0
                  ? "text-ink-slate border-gray-200 bg-gray-50 hover:bg-gray-100"
                  : "text-teal hover:text-teal-dark border-teal/40 hover:border-teal bg-white"
              }`}
              title="Download QBO-compatible .xls — upload in QBO under Banking → Rules → ⋮ → Import Rules. Only includes new rules to prevent QBO duplicates."
            >
              <Download size={14} />
              {exportStats && exportStats.never_exported === 0
                ? "Nothing new to export"
                : exportStats
                ? `Download .xls (${exportStats.never_exported} new)`
                : "Download .xls for QBO"}
            </a>
          </div>
        </div>
      )}

      {/* Filter tabs + bulk actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {(["all", "pending", "approved", "rejected", "flagged"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize ${
                filter === f
                  ? "bg-navy text-white"
                  : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
              }`}
            >
              {f === "flagged" ? "Need Review" : f}
            </button>
          ))}
        </div>
        {!isComplete && (
          <button
            onClick={bulkApprove}
            className="text-xs font-semibold bg-teal-light text-teal px-3 py-1.5 rounded-md hover:bg-teal/20"
          >
            Auto-Approve Top Rules
          </button>
        )}
      </div>

      {/* Rules table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 mb-6">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "1.5fr 1.5fr 1fr 0.7fr 1.2fr" }}
        >
          <div>Vendor Pattern</div>
          <div>→ Target Account</div>
          <div>Volume</div>
          <div>Confidence</div>
          <div>Decision</div>
        </div>

        {filtered.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            disabled={isComplete}
            accounts={accounts}
            accountsLoading={accountsLoading}
            reclassAccount={reclassByVendor[rule.vendor_pattern] || null}
            onUpdate={(updates) => updateRule(rule.id, updates)}
          />
        ))}

        {filtered.length === 0 && (
          <p className="text-sm text-ink-slate py-12 text-center">No rules match this filter.</p>
        )}
      </div>

      {!isComplete && (
        <div className="flex justify-between items-center">
          <button
            onClick={() => router.back()}
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            ← Back
          </button>
          <div className="flex items-center gap-4">
            {counts.approved > 0 && (
              <p className="text-xs text-ink-slate max-w-xs text-right">
                Once activated, these {counts.approved} rules will automatically categorize new bank
                transactions in QuickBooks.
              </p>
            )}
            <button
              onClick={executeApproved}
              disabled={executing || counts.approved === 0}
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              {executing ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
              {executing ? "Activating..." : "Activate Approved Rules"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  disabled,
  accounts,
  accountsLoading,
  reclassAccount,
  onUpdate,
}: {
  rule: Rule;
  disabled: boolean;
  accounts: CoaAccount[];
  accountsLoading: boolean;
  reclassAccount: string | null;
  onUpdate: (updates: Partial<Rule>) => void;
}) {
  const confidencePct = Math.round((rule.ai_confidence || 0) * 100);
  const txCount = rule.transaction_count || 0;
  const total = rule.total_amount || 0;

  const statusColors: Record<string, { bg: string; color: string }> = {
    pending: { bg: "#FEF3C7", color: "#F59E0B" },
    approved: { bg: "#D1FAE5", color: "#10B981" },
    rejected: { bg: "#FEE2E2", color: "#DC2626" },
    pushed: { bg: "#E8F2F0", color: "#2D7A75" },
  };
  const sc = statusColors[rule.status || "pending"];

  return (
    <div
      className="grid items-center px-5 py-3.5 hover:bg-teal-lighter transition-colors border-b border-gray-100"
      style={{ gridTemplateColumns: "1.5fr 1.5fr 1fr 0.7fr 1.2fr" }}
    >
      <div>
        <div className="font-semibold text-sm text-navy flex items-center gap-2">
          {rule.requires_approval && (
            <AlertTriangle size={13} className="text-yellow-600 flex-shrink-0" />
          )}
          {rule.vendor_pattern}
        </div>
        {rule.sample_descriptions && rule.sample_descriptions.length > 0 && (
          <div className="text-xs text-ink-slate mt-0.5 truncate">
            e.g., {rule.sample_descriptions[0]}
          </div>
        )}
      </div>
      <div className="text-sm pr-3">
        {disabled ? (
          <div className="font-semibold text-navy">{rule.target_account_name}</div>
        ) : (
          <TargetAccountPicker
            value={rule.target_account_name}
            accounts={accounts}
            loading={accountsLoading}
            onChange={(name) => onUpdate({ target_account_name: name })}
          />
        )}
        {!disabled && reclassAccount &&
          (reclassAccount.toLowerCase() === (rule.target_account_name || "").toLowerCase() ? (
            <div className="text-[11px] mt-1 font-semibold text-teal flex items-center gap-1">
              <Undo2 size={11} /> From your reclass categorization
            </div>
          ) : (
            <button
              onClick={() => onUpdate({ target_account_name: reclassAccount })}
              className="text-[11px] mt-1 font-semibold text-teal hover:text-teal-dark flex items-center gap-1"
              title="Use the account you reclassed this vendor to in Step 2"
            >
              <Undo2 size={11} /> Reclass: {reclassAccount} — use it
            </button>
          ))}
        {rule.ai_reasoning && (
          <div className="text-xs italic mt-0.5 text-ink-slate line-clamp-1">{rule.ai_reasoning}</div>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-navy flex items-center gap-1">
          <Zap size={11} className="text-ink-light" />
          {txCount} tx
        </div>
        <div className="text-xs text-ink-slate flex items-center gap-1">
          <DollarSign size={10} />
          {total.toLocaleString("en-US", { maximumFractionDigits: 0 })}
        </div>
      </div>
      <div>
        <span
          className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold"
          style={{
            color: confidencePct >= 90 ? "#10B981" : confidencePct >= 70 ? "#F59E0B" : "#DC2626",
            backgroundColor: confidencePct >= 90 ? "#D1FAE5" : confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
          }}
        >
          {confidencePct}%
        </span>
      </div>
      <div className="flex items-center gap-1">
        {disabled ? (
          <span
            className="px-2 py-1 rounded text-xs font-semibold capitalize"
            style={{ backgroundColor: sc.bg, color: sc.color }}
          >
            {rule.status}
          </span>
        ) : (
          <>
            <button
              onClick={() => onUpdate({ status: "approved" })}
              className={`p-1.5 rounded-md ${
                rule.status === "approved"
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-50 text-ink-slate hover:bg-green-50"
              }`}
              title="Approve"
            >
              <Check size={14} />
            </button>
            <button
              onClick={() => onUpdate({ status: "rejected" })}
              className={`p-1.5 rounded-md ${
                rule.status === "rejected"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-50 text-ink-slate hover:bg-red-50"
              }`}
              title="Reject"
            >
              <X size={14} />
            </button>
            <button
              onClick={() => onUpdate({ status: "pending" })}
              className={`p-1.5 rounded-md ${
                rule.status === "pending"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-gray-50 text-ink-slate hover:bg-yellow-50"
              }`}
              title="Mark pending"
            >
              <Flag size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TargetAccountPicker({
  value,
  accounts,
  loading,
  onChange,
}: {
  value: string;
  accounts: CoaAccount[];
  loading: boolean;
  onChange: (name: string) => void;
}) {
  // Store the account NAME (not id): bank rules are matched by name at apply
  // time (lib/daily-recon.ts → accountByName), and reclass stores the same.
  // The saved value is always shown — even before the COA loads, or if the AI
  // picked a name that doesn't exactly match a live account — so the bookkeeper
  // never sees the target silently blanked.
  const hasMatch = accounts.some((a) => a.name === value);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={loading && accounts.length === 0}
      className="w-full bg-white border border-gray-200 rounded-md px-2 py-1.5 text-sm font-semibold text-navy outline-none focus:border-teal focus:ring-1 focus:ring-teal disabled:opacity-60"
      title="Change the account this rule categorizes matching transactions to"
    >
      {(!hasMatch || (loading && accounts.length === 0)) && value && (
        <option value={value}>
          {value}
          {loading && accounts.length === 0 ? "  (loading accounts…)" : ""}
        </option>
      )}
      {accounts.map((a) => (
        <option key={a.id} value={a.name}>
          {a.fullyQualifiedName}
          {a.accountType ? ` · ${a.accountType}` : ""}
        </option>
      ))}
    </select>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="p-4 rounded-lg bg-white border border-gray-200">
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-xs mt-1 font-semibold text-ink-slate">{label}</div>
    </div>
  );
}
