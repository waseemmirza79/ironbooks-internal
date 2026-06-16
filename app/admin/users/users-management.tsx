"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserPlus, MoreVertical, Power, PowerOff, ChevronDown, Loader2, Mail, X, Shield, Crown, User as UserIcon, Eye, CheckCircle2, ArrowRightLeft, Building2, AlertTriangle, Check } from "lucide-react";

interface UserStats {
  id: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  total_cleanups: number;
  completed_cleanups: number;
  active_cleanups: number;
  failed_cleanups: number;
  cleanups_this_week: number;
  cleanups_this_month: number;
  avg_duration_seconds: number | null;
  total_rules_pushed: number;
  flags_reviewed: number;
  last_activity_at: string | null;
}

interface ClientLite {
  id: string;
  client_name: string;
  status: string | null;
}

export function UsersManagement({ initialUsers }: { initialUsers: UserStats[] }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [showInvite, setShowInvite] = useState(false);
  // Transfer-clients flow: { user, deactivateOnDone, initialClients? }
  const [transferFor, setTransferFor] = useState<
    { user: UserStats; deactivateOnDone: boolean; initialClients?: ClientLite[] } | null
  >(null);

  async function updateUser(userId: string, updates: { role?: string; is_active?: boolean }) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Failed: ${error}`);
      return;
    }

    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, ...updates } : u))
    );
    router.refresh();
  }

  // Deactivating a bookkeeper who still owns active clients should never
  // silently orphan their book — check first, and if they have clients, open
  // the transfer modal (which can reassign + deactivate in one step).
  async function requestDeactivate(u: UserStats) {
    try {
      const res = await fetch(`/api/admin/users/${u.id}/clients`);
      const body = await res.json().catch(() => ({ clients: [] }));
      const clients: ClientLite[] = body.clients || [];
      if (clients.length > 0) {
        setTransferFor({ user: u, deactivateOnDone: true, initialClients: clients });
      } else {
        updateUser(u.id, { is_active: false });
      }
    } catch {
      // If the check fails, fall back to opening the modal so the admin can
      // decide rather than deactivating blind.
      setTransferFor({ user: u, deactivateOnDone: true });
    }
  }

  function openTransfer(u: UserStats) {
    setTransferFor({ user: u, deactivateOnDone: false });
  }

  function onTransferDone(opts: { deactivatedUserId?: string }) {
    if (opts.deactivatedUserId) {
      setUsers((prev) => prev.map((u) => (u.id === opts.deactivatedUserId ? { ...u, is_active: false } : u)));
    }
    setTransferFor(null);
    router.refresh();
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowInvite(true)}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
        >
          <UserPlus size={16} />
          Invite Team Member
        </button>
      </div>

      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "2fr 1fr 1fr 0.8fr 0.8fr 1fr 0.6fr" }}
        >
          <div>User</div>
          <div>Role</div>
          <div>Cleanups</div>
          <div>This Week</div>
          <div>Rules</div>
          <div>Last Active</div>
          <div></div>
        </div>

        {users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            onUpdate={(updates) => updateUser(u.id, updates)}
            onRequestDeactivate={() => requestDeactivate(u)}
            onTransferClients={() => openTransfer(u)}
          />
        ))}

        {users.length === 0 && (
          <p className="py-12 text-center text-sm text-ink-slate">No users yet. Invite your first team member.</p>
        )}
      </div>

      {showInvite && <InviteModal onClose={() => { setShowInvite(false); router.refresh(); }} />}

      {transferFor && (
        <TransferClientsModal
          sourceUser={transferFor.user}
          deactivateOnDone={transferFor.deactivateOnDone}
          initialClients={transferFor.initialClients}
          allUsers={users}
          onClose={() => setTransferFor(null)}
          onDone={onTransferDone}
        />
      )}
    </div>
  );
}

function UserRow({
  user,
  onUpdate,
  onRequestDeactivate,
  onTransferClients,
}: {
  user: UserStats;
  onUpdate: (updates: { role?: string; is_active?: boolean }) => void;
  onRequestDeactivate: () => void;
  onTransferClients: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);

  const roleConfig: Record<string, { icon: any; color: string; bg: string }> = {
    admin: { icon: Crown, color: "#7C3AED", bg: "#EDE9FE" },
    lead: { icon: Shield, color: "#2D7A75", bg: "#E8F2F0" },
    bookkeeper: { icon: UserIcon, color: "#475569", bg: "#F1F5F9" },
    viewer: { icon: Eye, color: "#94A3B8", bg: "#F8FAFC" },
  };
  const rc = roleConfig[user.role] || roleConfig.bookkeeper;
  const RoleIcon = rc.icon;

  return (
    <div
      className={`grid items-center px-5 py-3.5 border-b border-gray-100 hover:bg-teal-lighter transition-colors ${
        !user.is_active ? "opacity-50" : ""
      }`}
      style={{ gridTemplateColumns: "2fr 1fr 1fr 0.8fr 0.8fr 1fr 0.6fr" }}
    >
      <Link href={`/admin/users/${user.id}`} className="flex items-center gap-3 min-w-0">
        <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-9 h-9 bg-teal-light text-teal">
          {user.full_name?.charAt(0) || "?"}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm text-navy truncate">{user.full_name}</div>
          <div className="text-xs text-ink-slate truncate">{user.email}</div>
        </div>
      </Link>

      <div className="relative">
        <button
          onClick={() => setRoleMenuOpen(!roleMenuOpen)}
          disabled={!user.is_active}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold capitalize"
          style={{ color: rc.color, backgroundColor: rc.bg }}
        >
          <RoleIcon size={12} />
          {user.role}
          <ChevronDown size={11} />
        </button>

        {roleMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setRoleMenuOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-20 rounded-lg shadow-lg overflow-hidden bg-white border border-gray-200 min-w-[140px]">
              {(["admin", "lead", "bookkeeper", "viewer"] as const).map((r) => {
                const rcc = roleConfig[r];
                const Ricon = rcc.icon;
                const isCurrent = r === user.role;
                return (
                  <button
                    key={r}
                    onClick={() => {
                      if (!isCurrent) onUpdate({ role: r });
                      setRoleMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
                    style={{ color: rcc.color }}
                  >
                    <Ricon size={12} />
                    <span className="capitalize">{r}</span>
                    {isCurrent && <CheckCircle2 size={12} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="text-sm font-bold text-navy">{user.completed_cleanups || 0}</div>
        <div className="text-xs text-ink-slate">
          {user.active_cleanups || 0} active
          {user.failed_cleanups > 0 && (
            <span className="text-red-600"> · {user.failed_cleanups} failed</span>
          )}
        </div>
      </div>

      <div className="text-sm font-bold text-navy">{user.cleanups_this_week || 0}</div>

      <div>
        <div className="text-sm font-bold text-navy">{user.total_rules_pushed || 0}</div>
        <div className="text-xs text-ink-slate">{user.flags_reviewed} flags</div>
      </div>

      <div className="text-xs text-ink-slate">
        {user.last_activity_at ? formatTimeAgo(user.last_activity_at) : "Never"}
      </div>

      <div className="relative flex justify-end">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="p-1.5 rounded-md hover:bg-gray-100"
        >
          <MoreVertical size={14} className="text-ink-slate" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-1 z-20 rounded-lg shadow-lg overflow-hidden bg-white border border-gray-200 min-w-[170px]">
              <Link
                href={`/admin/users/${user.id}`}
                className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
              >
                View activity
              </Link>
              {user.role !== "viewer" && (
                <button
                  onClick={() => {
                    onTransferClients();
                    setMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
                >
                  <ArrowRightLeft size={12} className="text-ink-slate" />
                  Transfer clients
                </button>
              )}
              <button
                onClick={() => {
                  if (user.is_active) {
                    // Route deactivation through the clients check so we never
                    // orphan an active book (offer reassignment first).
                    onRequestDeactivate();
                  } else {
                    onUpdate({ is_active: true });
                  }
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
              >
                {user.is_active ? (
                  <>
                    <PowerOff size={12} className="text-red-600" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <Power size={12} className="text-green-600" />
                    Reactivate
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TransferClientsModal({
  sourceUser,
  deactivateOnDone,
  initialClients,
  allUsers,
  onClose,
  onDone,
}: {
  sourceUser: UserStats;
  deactivateOnDone: boolean;
  initialClients?: ClientLite[];
  allUsers: UserStats[];
  onClose: () => void;
  onDone: (opts: { deactivatedUserId?: string }) => void;
}) {
  const [clients, setClients] = useState<ClientLite[] | null>(initialClients ?? null);
  const [loading, setLoading] = useState(!initialClients);
  // client_link_id → target bookkeeper id ("" = no target chosen yet)
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [bulkTarget, setBulkTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Eligible targets: active staff who can own clients, minus the source user.
  const candidates = allUsers.filter(
    (u) => u.is_active && u.id !== sourceUser.id && ["admin", "lead", "bookkeeper"].includes(u.role)
  );

  useEffect(() => {
    if (initialClients) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/users/${sourceUser.id}/clients`);
        const body = await res.json();
        if (!cancelled) setClients(body.clients || []);
      } catch {
        if (!cancelled) setClients([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceUser.id, initialClients]);

  const list = clients || [];
  const assignedCount = list.filter((c) => targets[c.id]).length;
  const unassignedCount = list.length - assignedCount;

  function applyBulk() {
    if (!bulkTarget) return;
    setTargets(Object.fromEntries(list.map((c) => [c.id, bulkTarget])));
  }

  async function submit(deactivate: boolean) {
    setError("");
    const assignments = list
      .filter((c) => targets[c.id])
      .map((c) => ({ client_link_id: c.id, to_bookkeeper_id: targets[c.id] }));

    if (deactivate && unassignedCount > 0) {
      const ok = confirm(
        `${unassignedCount} client${unassignedCount === 1 ? "" : "s"} ${unassignedCount === 1 ? "has" : "have"} no new owner and will be left unassigned when ${sourceUser.full_name} is deactivated. Continue?`
      );
      if (!ok) return;
    }
    if (!deactivate && assignments.length === 0) {
      setError("Choose a new owner for at least one client.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${sourceUser.id}/transfer-clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments, deactivate }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onDone({ deactivatedUserId: body.deactivated ? sourceUser.id : undefined });
    } catch (e: any) {
      setError(e?.message || "Transfer failed");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light flex-shrink-0">
              <ArrowRightLeft size={18} className="text-teal" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-navy truncate">
                {deactivateOnDone ? `Reassign ${sourceUser.full_name}'s clients` : `Transfer ${sourceUser.full_name}'s clients`}
              </h3>
              <p className="text-xs text-ink-slate">
                {deactivateOnDone
                  ? "Hand off their book before deactivating, so nothing is orphaned."
                  : "Move some or all of their clients to other bookkeepers or managers."}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 flex-shrink-0">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm text-ink-slate">
            <Loader2 size={20} className="animate-spin mx-auto mb-2 text-teal" />
            Loading clients…
          </div>
        ) : list.length === 0 ? (
          <div className="p-6">
            <div className="p-4 bg-gray-50 rounded-lg text-sm text-ink-slate text-center">
              {sourceUser.full_name} has no active clients assigned — nothing to transfer.
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <button onClick={onClose} className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2">
                Cancel
              </button>
              {deactivateOnDone && (
                <button
                  onClick={() => submit(true)}
                  disabled={saving}
                  className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <PowerOff size={14} />}
                  Deactivate {sourceUser.full_name?.split(" ")[0]}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Bulk assign */}
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-ink-slate">
                {list.length} active client{list.length === 1 ? "" : "s"} · assign all to:
              </span>
              <select
                value={bulkTarget}
                onChange={(e) => setBulkTarget(e.target.value)}
                className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
              >
                <option value="">Choose…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} ({c.role})
                  </option>
                ))}
              </select>
              <button
                onClick={applyBulk}
                disabled={!bulkTarget}
                className="text-xs font-semibold text-teal hover:text-teal-dark border border-teal/30 px-3 py-1.5 rounded-lg disabled:opacity-40"
              >
                Apply to all
              </button>
            </div>

            {/* Per-client target */}
            <div className="overflow-y-auto px-6 py-2 flex-1">
              {list.map((c) => (
                <div key={c.id} className="flex items-center gap-3 py-2.5 border-b border-gray-100 last:border-0">
                  <Building2 size={15} className="text-ink-light flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-navy truncate">{c.client_name}</div>
                    {c.status && <div className="text-xs text-ink-slate capitalize">{c.status}</div>}
                  </div>
                  <ArrowRightLeft size={13} className="text-ink-light flex-shrink-0" />
                  <select
                    value={targets[c.id] || ""}
                    onChange={(e) => setTargets((t) => ({ ...t, [c.id]: e.target.value }))}
                    className={`px-2.5 py-1.5 border rounded-lg text-sm outline-none focus:border-teal bg-white min-w-[170px] ${
                      targets[c.id] ? "border-teal/40 text-navy" : "border-gray-200 text-ink-slate"
                    }`}
                  >
                    <option value="">— Keep / choose —</option>
                    {candidates.map((cand) => (
                      <option key={cand.id} value={cand.id}>
                        {cand.full_name} ({cand.role})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 space-y-3">
              {deactivateOnDone && unassignedCount > 0 && (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  {unassignedCount} client{unassignedCount === 1 ? "" : "s"} still {unassignedCount === 1 ? "has" : "have"} no new owner — they&apos;ll be left unassigned if you deactivate now.
                </div>
              )}
              {error && <div className="text-sm font-semibold text-red-600">{error}</div>}

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-xs text-ink-slate">
                  {assignedCount} of {list.length} assigned a new owner
                </span>
                <div className="flex items-center gap-3">
                  <button onClick={onClose} className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2">
                    Cancel
                  </button>
                  {deactivateOnDone ? (
                    <>
                      <button
                        onClick={() => submit(false)}
                        disabled={saving || assignedCount === 0}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:text-teal-dark border border-teal/30 px-4 py-2 rounded-lg disabled:opacity-40"
                      >
                        Transfer only
                      </button>
                      <button
                        onClick={() => submit(true)}
                        disabled={saving}
                        className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
                      >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Transfer & deactivate
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => submit(false)}
                      disabled={saving || assignedCount === 0}
                      className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                      Transfer {assignedCount > 0 ? assignedCount : ""} client{assignedCount === 1 ? "" : "s"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("bookkeeper");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);

    const res = await fetch("/api/admin/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, full_name: name, role }),
    });

    if (res.ok) {
      setSent(true);
    } else {
      const { error: errMsg } = await res.json();
      setError(errMsg);
    }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
              <Mail size={18} className="text-teal" />
            </div>
            <h3 className="text-lg font-bold text-navy">Invite Team Member</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        {sent ? (
          <div className="p-6 text-center">
            <CheckCircle2 size={36} className="text-green-500 mx-auto mb-3" />
            <h4 className="font-bold text-navy mb-1">Invite sent</h4>
            <p className="text-sm text-ink-slate mb-4">
              {email} will receive a magic-link email to sign in.
            </p>
            <button
              onClick={onClose}
              className="bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2 rounded-lg"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Full name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lisa Smith"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="lisa@ironbooks.com"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
              >
                <option value="bookkeeper">Bookkeeper — does cleanups</option>
                <option value="lead">Lead — reviews flagged items + audit log</option>
                <option value="viewer">Viewer — read-only</option>
                <option value="admin">Admin — full access incl. user management</option>
              </select>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2"
              >
                Cancel
              </button>
              <button
                onClick={send}
                disabled={sending || !email || !name}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                {sending ? "Sending..." : "Send Invite"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
