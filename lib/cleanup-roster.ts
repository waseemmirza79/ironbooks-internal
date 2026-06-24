/**
 * Cleanup launcher roster — buckets every active client into the five sections
 * the New Cleanup page renders. One pass, mutually-exclusive by precedence
 * (first match wins):
 *   1. bs        — in production but Balance Sheet still owed (bs_enabled=false)
 *   2. completed — done + in production (or cleanup_completed_at set)
 *   3. stripe    — a connect request was sent and we're still waiting to connect
 *   4. continue  — finished ≥1 cleanup step, still before P&L send / close
 *   5. new       — never finished a step yet
 *
 * "Finished a step" = a COA / reclass / bank-rules job reached 'complete', or the
 * cleanup was submitted for review, or Stripe got connected. A client who only
 * has a draft/in-progress job (nothing finished) is still "new".
 */

export type CleanupBucket = "new" | "continue" | "completed" | "stripe" | "bs";

export interface RosterClient {
  id: string;
  client_name: string;
  jurisdiction: string | null;
  state_province: string | null;
  qbo_connected: boolean;
  bucket: CleanupBucket;
  subLabel: string;
  /** pulled to the top + tinted (BS: statements received). */
  highlight: boolean;
  /** where a row click goes (null for "new" — handled by the setup form). */
  routeTarget: string | null;
  /** Stripe: when the connect request went out (for "waiting N days" + resend). */
  requestedAt: string | null;
}

export interface CleanupRoster {
  /** full client_links rows — the New-cleanup setup form needs jurisdiction/industry. */
  newCleanup: any[];
  continueCleanup: RosterClient[];
  completed: RosterClient[];
  stripeRecon: RosterClient[];
  bsCleanup: RosterClient[];
}

const RESUMABLE = new Set(["in_review", "executing", "failed", "draft", "pending_lisa", "approved"]);

export async function buildCleanupRoster(service: any): Promise<CleanupRoster> {
  const { data: clients } = await service
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .order("client_name");
  const list = ((clients as any[]) || []);
  const ids = list.map((c) => c.id);

  const empty: CleanupRoster = { newCleanup: [], continueCleanup: [], completed: [], stripeRecon: [], bsCleanup: [] };
  if (ids.length === 0) return empty;

  const safe = async (p: Promise<any>) => { try { return await p; } catch { return { data: [] }; } };
  const [coaRes, reclassRes, rulesRes, stmtRes] = await Promise.all([
    safe(service.from("coa_jobs").select("id, client_link_id, status, updated_at").in("client_link_id", ids)),
    safe(service.from("reclass_jobs").select("client_link_id, status").in("client_link_id", ids)),
    safe(service.from("rule_discovery_jobs").select("client_link_id, status").in("client_link_id", ids)),
    safe(service.from("statement_requests").select("client_link_id, status").in("client_link_id", ids)),
  ]);

  const coaByClient = new Map<string, any[]>();
  for (const j of ((coaRes.data as any[]) || [])) {
    const arr = coaByClient.get(j.client_link_id) || [];
    arr.push(j);
    coaByClient.set(j.client_link_id, arr);
  }
  const completedStepClients = new Set<string>();
  for (const j of ((coaRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);
  for (const j of ((reclassRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);
  for (const j of ((rulesRes.data as any[]) || [])) if (j.status === "complete") completedStepClients.add(j.client_link_id);

  // statements: any fulfilled = received; any open = requested-and-waiting.
  const stmtReceived = new Set<string>();
  const stmtRequested = new Set<string>();
  for (const r of ((stmtRes.data as any[]) || [])) {
    if (r.status === "fulfilled") stmtReceived.add(r.client_link_id);
    if (r.status === "open") stmtRequested.add(r.client_link_id);
  }

  const out: CleanupRoster = { newCleanup: [], continueCleanup: [], completed: [], stripeRecon: [], bsCleanup: [] };

  for (const c of list) {
    const qboConnected = !!c.qbo_realm_id && !!c.qbo_refresh_token;
    const completedAt = c.cleanup_completed_at;
    const inProduction = c.daily_recon_enabled === true;
    const bsOwed = inProduction && c.bs_enabled === false;
    const stripeConnected = c.stripe_connection_status === "connected";
    const stripeRequested = !!c.stripe_connect_requested_at || !!c.stripe_request_sent_at;
    const stripeWaiting = stripeRequested && !stripeConnected && c.stripe_not_required !== true;
    const finishedStep =
      completedStepClients.has(c.id) ||
      c.cleanup_review_state === "in_review" ||
      c.cleanup_review_state === "complete" ||
      !!completedAt ||
      stripeConnected;

    const coaJobs = coaByClient.get(c.id) || [];
    const resumable = coaJobs
      .filter((j) => RESUMABLE.has(j.status))
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];

    const base = {
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction ?? null,
      state_province: c.state_province ?? null,
      qbo_connected: qboConnected,
      requestedAt: null as string | null,
    };

    // 1. BS Cleanup — in production, Balance Sheet still owed.
    if (bsOwed) {
      const received = stmtReceived.has(c.id);
      out.bsCleanup.push({
        ...base,
        bucket: "bs",
        highlight: received,
        subLabel: received
          ? "Statements received — ready to finish BS"
          : stmtRequested.has(c.id) || c.bs_statements_requested_at
          ? "Waiting on client for statements"
          : "Statements not yet requested",
        routeTarget: `/balance-sheet/${c.id}`,
      });
      continue;
    }

    // 2. Completed — done + in production (or fully closed).
    if (inProduction || completedAt) {
      out.completed.push({
        ...base,
        bucket: "completed",
        highlight: false,
        subLabel: completedAt
          ? `Completed ${new Date(completedAt).toLocaleDateString()}`
          : "In production",
        routeTarget: `/clients/${c.id}`,
      });
      continue;
    }

    // 3. Stripe recon — request sent, still waiting to connect.
    if (stripeWaiting) {
      out.stripeRecon.push({
        ...base,
        bucket: "stripe",
        highlight: false,
        subLabel: "Waiting to connect",
        routeTarget: `/stripe-recon/new?client=${c.id}`,
        requestedAt: c.stripe_connect_requested_at || c.stripe_request_sent_at || null,
      });
      continue;
    }

    // 4. Continue cleanup — finished ≥1 step, still before P&L/close.
    if (finishedStep) {
      out.continueCleanup.push({
        ...base,
        bucket: "continue",
        highlight: false,
        subLabel: stripeConnected
          ? "Stripe connected — ready to reconcile"
          : c.cleanup_review_state === "in_review"
          ? "Submitted — in senior review"
          : resumable
          ? `In progress — ${String(resumable.status).replace("_", " ")}`
          : "Cleanup in progress",
        routeTarget: stripeConnected
          ? `/stripe-recon/new?client=${c.id}`
          : resumable
          ? `/jobs/${resumable.id}/review`
          : `/clients/${c.id}`,
      });
      continue;
    }

    // 5. New cleanup — nothing finished yet. Full row for the setup form.
    out.newCleanup.push(c);
  }

  return out;
}
