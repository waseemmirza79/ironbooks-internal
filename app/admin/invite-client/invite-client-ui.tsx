"use client";

import { useState, useMemo } from "react";
import {
  Search, Mail, CheckCircle2, AlertCircle, Loader2, X,
  RefreshCw, Clock, UserMinus, Send, Eye,
} from "lucide-react";

interface Client {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  client_email: string | null;
  /** Server-side heuristic name extracted from client_name. May be null. */
  suggested_full_name: string | null;
}

interface Mapping {
  id: string;
  user_id: string;
  client_link_id: string;
  invited_at: string;
  first_login_at: string | null;
  last_login_at: string | null;
  active: boolean;
  user_email: string;
  user_full_name: string;
  user_active: boolean;
  client_name: string;
  invited_by_name: string;
}

export function InviteClientUI({
  clients,
  existingMappings,
}: {
  clients: Client[];
  existingMappings: Mapping[];
}) {
  const [clientId, setClientId] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [silent, setSilent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastCreatedUserId, setLastCreatedUserId] = useState<string | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [listSearch, setListSearch] = useState("");

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    if (!q) return clients.slice(0, 15);
    return clients.filter((c) =>
      c.client_name.toLowerCase().includes(q) ||
      (c.client_email || "").toLowerCase().includes(q)
    ).slice(0, 30);
  }, [clients, clientSearch]);

  const filteredMappings = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return existingMappings;
    return existingMappings.filter((m) =>
      m.user_email.toLowerCase().includes(q) ||
      m.user_full_name.toLowerCase().includes(q) ||
      m.client_name.toLowerCase().includes(q)
    );
  }, [existingMappings, listSearch]);

  // Auto-fill email + name from client_links data when a client is picked.
  // Always overwrites (vs only-when-empty) so picking a different client
  // doesn't leave stale data from a previous selection. Admin can still
  // edit before sending.
  const [emailPrefilled, setEmailPrefilled] = useState(false);
  const [namePrefilled, setNamePrefilled] = useState(false);
  function pickClient(c: Client) {
    setClientId(c.id);
    if (c.client_email) {
      setEmail(c.client_email);
      setEmailPrefilled(true);
    } else {
      setEmailPrefilled(false);
    }
    if (c.suggested_full_name) {
      setFullName(c.suggested_full_name);
      setNamePrefilled(true);
    } else {
      setNamePrefilled(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLastCreatedUserId(null);
    if (!clientId || !email || !fullName) {
      setError("All fields required.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/admin/invite-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim(),
          client_link_id: clientId,
          send_invite: !silent,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(body.message || "Done");
      // For silent creates, surface the user_id so admin can jump straight
      // into impersonation without scrolling to find them in the table.
      if (silent && body.user_id) {
        setLastCreatedUserId(body.user_id);
        // Don't reload — let the admin click "View portal now"
        setEmail("");
        setFullName("");
        setClientId("");
      } else {
        setEmail("");
        setFullName("");
        setClientId("");
        window.location.reload();
      }
    } catch (e: any) {
      setError(e?.message || "Invite failed");
    } finally {
      setLoading(false);
    }
  }

  async function viewAsNewUser() {
    if (!lastCreatedUserId) return;
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: lastCreatedUserId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      window.location.href = body.redirect || "/portal";
    } catch (e: any) {
      setError(e?.message || "Couldn't start portal session");
    }
  }

  async function resend(targetEmail: string, fullName: string, clientLinkId: string) {
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/admin/invite-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          full_name: fullName,
          client_link_id: clientLinkId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(body.message || "Magic link re-sent");
    } catch (e: any) {
      setError(e?.message || "Resend failed");
    }
  }

  async function impersonate(userId: string, label: string) {
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: userId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      // Hard-navigate so the impersonation cookie is honored on the next request.
      window.location.href = body.redirect || "/portal";
    } catch (e: any) {
      setError(`Couldn't impersonate ${label}: ${e?.message || "unknown"}`);
    }
  }

  async function revoke(userId: string, label: string) {
    if (!confirm(`Revoke portal access for ${label}? Their account stays but they can no longer log in to the portal.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/invite-client?user_id=${userId}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSuccess(`Revoked ${label}`);
      window.location.reload();
    } catch (e: any) {
      setError(e?.message || "Revoke failed");
    }
  }

  const selectedClient = clients.find((c) => c.id === clientId);

  return (
    <div className="space-y-6">
      {/* Invite form */}
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="font-bold text-navy">Send a portal invite</h2>
          <p className="text-xs text-ink-slate mt-0.5">
            The client receives a magic-link email. Clicking it signs them in and drops them on{" "}
            <code className="bg-slate-100 px-1 rounded">/portal</code>.
          </p>
        </div>

        {/* Client picker */}
        <div>
          <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Client</label>
          {selectedClient ? (
            <div className="mt-1 flex items-center gap-2 p-2 bg-teal/5 border border-teal/30 rounded-lg">
              <CheckCircle2 size={14} className="text-teal-dark" />
              <span className="flex-1 text-sm font-semibold text-navy">
                {selectedClient.client_name}
                <span className="text-xs text-ink-slate ml-2 font-normal">
                  {selectedClient.jurisdiction}
                  {selectedClient.state_province ? ` · ${selectedClient.state_province}` : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() => { setClientId(""); setClientSearch(""); }}
                className="text-ink-slate hover:text-navy"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="mt-1">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
                <input
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Search clients…"
                  className="w-full pl-8 pr-2 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              {filteredClients.length > 0 && (
                <ul className="mt-1 border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
                  {filteredClients.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pickClient(c)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                      >
                        <span className="font-semibold text-navy">{c.client_name}</span>
                        <span className="text-xs text-ink-slate ml-2">
                          {c.jurisdiction}
                          {c.state_province ? ` · ${c.state_province}` : ""}
                          {c.client_email ? ` · ${c.client_email}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Email + name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Email</label>
              {emailPrefilled && (
                <span className="text-[9px] font-bold bg-teal-light text-teal-dark px-1.5 py-0.5 rounded">
                  PULLED — VERIFY
                </span>
              )}
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailPrefilled) setEmailPrefilled(false);
              }}
              placeholder="owner@business.com"
              className={`mt-1 w-full px-3 py-2 text-sm border rounded-lg ${
                emailPrefilled ? "border-teal/40 bg-teal/5" : "border-slate-200"
              }`}
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-ink-slate uppercase tracking-wider">Full name</label>
              {namePrefilled && (
                <span className="text-[9px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                  GUESSED — VERIFY
                </span>
              )}
            </div>
            <input
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                if (namePrefilled) setNamePrefilled(false);
              }}
              placeholder="Jane Smith"
              className={`mt-1 w-full px-3 py-2 text-sm border rounded-lg ${
                namePrefilled ? "border-amber-300 bg-amber-50" : "border-slate-200"
              }`}
            />
          </div>
        </div>
        {(emailPrefilled || namePrefilled) && (
          <div className="text-[11px] text-ink-light -mt-1">
            {emailPrefilled && <>📧 Email pulled from this client's record. </>}
            {namePrefilled && <>👤 Name guessed from the company name — double-check before sending.</>}
          </div>
        )}

        {/* Silent-create checkbox. Defaults off so the common case still
            sends the magic-link email. */}
        <label className="flex items-start gap-2 text-xs text-ink-slate cursor-pointer">
          <input
            type="checkbox"
            checked={silent}
            onChange={(e) => setSilent(e.target.checked)}
            className="mt-0.5 rounded border-slate-300"
          />
          <span>
            <strong className="text-navy">Create silently — don't send the email</strong>
            <span className="block text-[11px] text-ink-light">
              The account is provisioned but no magic link goes out. Use for testing — you'll
              be able to impersonate the user immediately to walk the portal.
            </span>
          </span>
        </label>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError("")} className="text-red-700">
              <X size={14} />
            </button>
          </div>
        )}
        {success && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-800 flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <div>{success}</div>
              {lastCreatedUserId && (
                <button
                  type="button"
                  onClick={viewAsNewUser}
                  className="mt-2 inline-flex items-center gap-1 px-3 py-1 bg-amber-500 text-white text-xs font-bold rounded hover:bg-amber-600"
                >
                  <Eye size={11} /> View portal as this user now
                </button>
              )}
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-2"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {loading ? (silent ? "Creating…" : "Sending…") : (silent ? "Create silently" : "Send invite")}
        </button>
      </form>

      <BulkCreatePanel clients={clients} existingMappings={existingMappings} />

      {/* Existing portal users */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <h2 className="font-bold text-navy">
            Portal users
            <span className="text-xs text-ink-slate ml-2 font-normal">
              ({existingMappings.length} total · {existingMappings.filter((m) => m.active).length} active)
            </span>
          </h2>
          <div className="relative max-w-xs">
            <Search size={13} className="absolute left-2.5 top-2.5 text-ink-slate" />
            <input
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="Search by name, email, or client…"
              className="pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-lg w-full"
            />
          </div>
        </div>

        {filteredMappings.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-slate">
            {existingMappings.length === 0
              ? "No portal users yet — invite someone above."
              : "No matches for your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-ink-slate uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">User</th>
                <th className="text-left px-4 py-2 font-semibold">Client</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="text-left px-4 py-2 font-semibold">Last login</th>
                <th className="text-right px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredMappings.map((m) => {
                const daysSinceInvite = Math.floor(
                  (Date.now() - new Date(m.invited_at).getTime()) / 86_400_000
                );
                const neverLoggedIn = !m.first_login_at;
                const staleInvite = neverLoggedIn && daysSinceInvite > 7;
                return (
                  <tr key={m.id} className={!m.active ? "opacity-50" : ""}>
                    <td className="px-4 py-2">
                      <div className="font-semibold text-navy">{m.user_full_name || "—"}</div>
                      <div className="text-xs text-ink-slate">{m.user_email}</div>
                    </td>
                    <td className="px-4 py-2 text-ink-slate">{m.client_name}</td>
                    <td className="px-4 py-2">
                      {!m.active ? (
                        <span className="text-[10px] font-bold bg-slate-200 text-ink-slate px-1.5 py-0.5 rounded">
                          REVOKED
                        </span>
                      ) : staleInvite ? (
                        <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                          NEVER LOGGED IN ({daysSinceInvite}d)
                        </span>
                      ) : neverLoggedIn ? (
                        <span className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                          INVITED ({daysSinceInvite}d)
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-slate">
                      {m.last_login_at ? (
                        <>
                          <Clock size={10} className="inline mr-0.5" />
                          {timeAgo(m.last_login_at)}
                        </>
                      ) : (
                        <span className="italic text-ink-light">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {m.active ? (
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() => impersonate(m.user_id, m.user_email)}
                            title="View the portal as this client (4h session)"
                            className="p-1.5 rounded hover:bg-amber-50 text-ink-slate hover:text-amber-700"
                          >
                            <Eye size={13} />
                          </button>
                          <button
                            onClick={() => resend(m.user_email, m.user_full_name, m.client_link_id)}
                            title="Re-send magic link"
                            className="p-1.5 rounded hover:bg-slate-100 text-ink-slate hover:text-navy"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button
                            onClick={() => revoke(m.user_id, m.user_email)}
                            title="Revoke portal access"
                            className="p-1.5 rounded hover:bg-red-50 text-ink-slate hover:text-red-700"
                          >
                            <UserMinus size={13} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => resend(m.user_email, m.user_full_name, m.client_link_id)}
                          title="Re-enable + resend magic link"
                          className="text-xs font-semibold text-teal hover:underline"
                        >
                          Re-enable
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="text-xs text-ink-light">
        <strong>Tip:</strong> The magic-link email comes from Supabase. If clients say they didn't get it,
        ask them to check spam. You can resend any time with the <RefreshCw size={10} className="inline" /> button.
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor(diffMs / 60_000);
  if (days >= 1) return `${days}d ago`;
  if (hours >= 1) return `${hours}h ago`;
  if (mins >= 1) return `${mins}m ago`;
  return "just now";
}

/* ── Bulk account creation ────────────────────────────────────────────
   One row per active client with NO active portal user. Email/name
   prefill from client_links; rows without an email start unchecked.
   A single switch decides whether invite emails go out or accounts are
   provisioned silently (admin can impersonate + invite later). Each row
   drives the same POST /api/admin/invite-client as the single form, run
   sequentially so per-row failures are isolated and readable. */

interface BulkRowState {
  checked: boolean;
  email: string;
  fullName: string;
  status: "idle" | "working" | "ok" | "error";
  message: string;
}

function BulkCreatePanel({
  clients,
  existingMappings,
}: {
  clients: Client[];
  existingMappings: Mapping[];
}) {
  const missing = useMemo(() => {
    const covered = new Set(
      existingMappings.filter((m) => m.active).map((m) => m.client_link_id)
    );
    return clients.filter((c) => !covered.has(c.id));
  }, [clients, existingMappings]);

  const [open, setOpen] = useState(false);
  const [sendEmails, setSendEmails] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Record<string, BulkRowState>>(() => {
    const init: Record<string, BulkRowState> = {};
    for (const c of missing) {
      init[c.id] = {
        checked: !!c.client_email,
        email: c.client_email || "",
        fullName: c.suggested_full_name || c.client_name,
        status: "idle",
        message: "",
      };
    }
    return init;
  });

  const row = (id: string): BulkRowState =>
    rows[id] || { checked: false, email: "", fullName: "", status: "idle", message: "" };
  const patch = (id: string, p: Partial<BulkRowState>) =>
    setRows((r) => ({ ...r, [id]: { ...row(id), ...p } }));

  const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const selected = missing.filter((c) => row(c.id).checked && validEmail(row(c.id).email));
  const doneCount = missing.filter((c) => row(c.id).status === "ok").length;

  async function runBulk() {
    if (selected.length === 0 || running) return;
    setRunning(true);
    for (const c of selected) {
      const r = row(c.id);
      if (r.status === "ok") continue;
      patch(c.id, { status: "working", message: "" });
      try {
        const res = await fetch("/api/admin/invite-client", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: r.email.trim(),
            full_name: r.fullName.trim() || c.client_name,
            client_link_id: c.id,
            send_invite: sendEmails,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        patch(c.id, { status: "ok", message: body.message || "Created" });
      } catch (e: any) {
        patch(c.id, { status: "error", message: e?.message || "Failed" });
      }
    }
    setRunning(false);
  }

  if (missing.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-4 text-sm text-emerald-700 flex items-center gap-2">
        <CheckCircle2 size={15} /> Every active client has a portal account.
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full p-4 flex items-center justify-between gap-3 text-left"
      >
        <div>
          <h2 className="font-bold text-navy">
            Bulk-create portal accounts
            <span className="ml-2 text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
              {missing.length} client{missing.length === 1 ? "" : "s"} without portal access
            </span>
          </h2>
          <p className="text-xs text-ink-slate mt-0.5">
            Create accounts for everyone at once — with or without sending invite emails.
          </p>
        </div>
        <span className="text-xs font-semibold text-teal flex-shrink-0">{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200">
          {/* Controls */}
          <div className="p-4 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={sendEmails}
                onChange={(e) => setSendEmails(e.target.checked)}
                className="accent-teal"
                disabled={running}
              />
              <span className="text-navy font-semibold">Send invite emails</span>
              <span className="text-xs text-ink-slate">
                {sendEmails
                  ? "— each client gets a magic-link signup email immediately"
                  : "— accounts are created silently; invite or impersonate later"}
              </span>
            </label>
            <button
              type="button"
              onClick={runBulk}
              disabled={selected.length === 0 || running}
              className="px-4 py-2 bg-teal text-white rounded-lg text-sm font-semibold hover:bg-teal-dark disabled:opacity-50 inline-flex items-center gap-2"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {running
                ? `Creating… (${doneCount}/${selected.length})`
                : `Create ${selected.length} account${selected.length === 1 ? "" : "s"}${sendEmails ? " + send invites" : " (no emails)"}`}
            </button>
          </div>

          {/* Rows */}
          <div className="divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
            {missing.map((c) => {
              const r = row(c.id);
              const emailOk = validEmail(r.email);
              return (
                <div key={c.id} className="px-4 py-2.5 flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) => patch(c.id, { checked: e.target.checked })}
                    disabled={running || r.status === "ok"}
                    className="accent-teal flex-shrink-0"
                  />
                  <div className="w-56 flex-shrink-0 text-sm font-medium text-navy truncate" title={c.client_name}>
                    {c.client_name}
                  </div>
                  <input
                    type="email"
                    value={r.email}
                    onChange={(e) => patch(c.id, { email: e.target.value })}
                    placeholder="owner@example.com"
                    disabled={running || r.status === "ok"}
                    className={`flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border text-sm ${
                      r.checked && !emailOk ? "border-amber-300 bg-amber-50/40" : "border-slate-200"
                    }`}
                  />
                  <input
                    type="text"
                    value={r.fullName}
                    onChange={(e) => patch(c.id, { fullName: e.target.value })}
                    placeholder="Full name"
                    disabled={running || r.status === "ok"}
                    className="w-44 flex-shrink-0 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm"
                  />
                  <div className="w-40 flex-shrink-0 text-xs">
                    {r.status === "working" && (
                      <span className="text-ink-slate inline-flex items-center gap-1">
                        <Loader2 size={11} className="animate-spin" /> Creating…
                      </span>
                    )}
                    {r.status === "ok" && (
                      <span className="text-emerald-700 inline-flex items-center gap-1">
                        <CheckCircle2 size={11} /> {sendEmails ? "Invited" : "Created"}
                      </span>
                    )}
                    {r.status === "error" && (
                      <span className="text-red-700 inline-flex items-start gap-1" title={r.message}>
                        <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                        <span className="truncate">{r.message}</span>
                      </span>
                    )}
                    {r.status === "idle" && r.checked && !emailOk && (
                      <span className="text-amber-700">needs email</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
