/**
 * Cleanup launcher roster — buckets every active client into the five sections
 * the New Cleanup page renders. One pass, mutually-exclusive buckets by
 * precedence (first match wins):
 *   1. bs        — in production (daily_recon_enabled) + completed + BS deferred (bs_enabled=false)
 *   2. completed — cleanup_completed_at set (closed file, reopenable)
 *   3. stripe    — connect request sent, cleanup not yet done (the open loop)
 *   4. continue  — cleanup not done, but has motion (a COA/reclass job, or in_review)
 *   5. new       — active, nothing started
 *
 * Display order on the page differs (new, continue, completed, stripe, bs) —
 * precedence is only about which single bucket a client lands in.
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
  /** pulled to the top + tinted (Stripe connected, statements submitted). */
  highlight: boolean;
  /** where a row click goes (null for "new" — handled by the setup form). */
  routeTarget: string | null;
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

  // Batched fan-out — never per-client.
  const safe = async (p: Promise<any>) => { try { return await p; } catch { return { data: [] }; } };
  const [coaRes, reclassRes, stmtRes] = await Promise.all([
    safe(service.from("coa_jobs").select("id, client_link_id, status, updated_at").in("client_link_id", ids)),
    safe(service.from("reclass_jobs").select("client_link_id, status").in("client_link_id", ids)),
    safe(service.from("statement_requests").select("client_link_id, status").in("client_link_id", ids)),
  ]);

  const coaByClient = new Map<string, any[]>();
  for (const j of ((coaRes.data as any[]) || [])) {
    const arr = coaByClient.get(j.client_link_id) || [];
    arr.push(j);
    coaByClient.set(j.client_link_id, arr);
  }
  const reclassByClient = new Map<string, any[]>();
  for (const j of ((reclassRes.data as any[]) || [])) {
    const arr = reclassByClient.get(j.client_link_id) || [];
    arr.push(j);
    reclassByClient.set(j.client_link_id, arr);
  }
  const stmtFulfilledByClient = new Set<string>();
  for (const r of ((stmtRes.data as any[]) || [])) {
    if (r.status === "fulfilled") stmtFulfilledByClient.add(r.client_link_id);
  }

  const out: CleanupRoster = { newCleanup: [], continueCleanup: [], completed: [], stripeRecon: [], bsCleanup: [] };

  for (const c of list) {
    const qboConnected = !!c.qbo_realm_id && !!c.qbo_refresh_token;
    const completedAt = c.cleanup_completed_at;
    const inProduction = c.daily_recon_enabled === true;
    const coaJobs = coaByClient.get(c.id) || [];
    const reclassJobs = reclassByClient.get(c.id) || [];
    const resumable = coaJobs
      .filter((j) => RESUMABLE.has(j.status))
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
    const hasMotion =
      coaJobs.length > 0 || reclassJobs.length > 0 || c.cleanup_review_state === "in_review";
    const stripeRequested = !!c.stripe_connect_requested_at || !!c.stripe_request_sent_at;
    const stripeConnected = c.stripe_connection_status === "connected";
    const statementsSubmitted = stmtFulfilledByClient.has(c.id);

    const base = {
      id: c.id,
      client_name: c.client_name,
      jurisdiction: c.jurisdiction ?? null,
      state_province: c.state_province ?? null,
      qbo_connected: qboConnected,
    };

    // 1. BS Cleanup — in production but BS still owed.
    if (inProduction && completedAt && c.bs_enabled === false) {
      out.bsCleanup.push({
        ...base,
        bucket: "bs",
        highlight: statementsSubmitted,
        subLabel: statementsSubmitted
          ? "Statements submitted — ready to finish BS"
          : c.bs_statements_requested_at
          ? "Waiting on client for statements"
          : "Balance Sheet owed",
        routeTarget: `/balance-sheet/${c.id}`,
      });
      continue;
    }

    // 2. Completed (closed file).
    if (completedAt) {
      out.completed.push({
        ...base,
        bucket: "completed",
        highlight: false,
        subLabel: `Completed ${new Date(completedAt).toLocaleDateString()}`,
        routeTarget: `/clients/${c.id}`,
      });
      continue;
    }

    // 3. Stripe recon — a connect request is the open loop.
    if (stripeRequested && c.stripe_not_required !== true) {
      out.stripeRecon.push({
        ...base,
        bucket: "stripe",
        highlight: stripeConnected,
        subLabel: stripeConnected
          ? "Connected — ready to reconcile"
          : c.stripe_connect_reminder_count
          ? `Waiting to connect · ${c.stripe_connect_reminder_count} reminder(s)`
          : "Waiting to connect",
        routeTarget: `/stripe-recon/new?client=${c.id}`,
      });
      continue;
    }

    // 4. Continue cleanup — work already in motion.
    if (hasMotion) {
      out.continueCleanup.push({
        ...base,
        bucket: "continue",
        highlight: false,
        subLabel:
          c.cleanup_review_state === "in_review"
            ? "Submitted — in senior review"
            : resumable
            ? `COA cleanup — ${String(resumable.status).replace("_", " ")}`
            : reclassJobs.length > 0
            ? "Reclass in progress"
            : "Cleanup in progress",
        routeTarget: resumable ? `/jobs/${resumable.id}/review` : `/clients/${c.id}`,
      });
      continue;
    }

    // 5. New cleanup — nothing started. Full row for the setup form.
    out.newCleanup.push(c);
  }

  return out;
}
