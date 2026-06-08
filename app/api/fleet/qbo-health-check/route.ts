import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";

/**
 * GET /api/fleet/qbo-health-check
 *
 * Actively probes every active client's QBO connection by attempting a
 * refresh (via getValidToken). The static `qbo_token_expires_at` column
 * is the access-token expiry — usually <1h old — and tells you nothing
 * about whether the REFRESH token works. This endpoint does the real
 * test: it tries to refresh, and reports back which clients have a
 * dead refresh token (invalid_grant) vs which refreshed successfully.
 *
 * Admin/lead only — expensive (one QBO call per client). Don't put it
 * on a hot path. Runs sequentially with a short delay between calls
 * to stay under QBO rate limits.
 *
 * Returns JSON summary + per-client detail. The Fleet Health dashboard
 * can call this periodically (e.g. nightly cron) to populate a
 * `qbo_refresh_last_checked_at` column, which Panel C should display
 * instead of the misleading access-token expiry.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

interface ClientResult {
  client_link_id: string;
  client_name: string;
  qbo_realm_id: string | null;
  status: "ok" | "invalid_grant" | "no_realm" | "other_error";
  detail: string;
  // For the "ok" case — the new access-token expiry timestamp.
  new_expiry: string | null;
}

export async function GET(_request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) {
    return NextResponse.json({ error: "Forbidden — admin/lead only" }, { status: 403 });
  }

  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, qbo_token_expires_at")
    .eq("is_active", true)
    .order("client_name");

  const results: ClientResult[] = [];
  for (const c of (clients as any[]) || []) {
    if (!c.qbo_realm_id) {
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        qbo_realm_id: null,
        status: "no_realm",
        detail: "Never connected to QBO.",
        new_expiry: null,
      });
      continue;
    }

    try {
      // This is the actual test — getValidToken refreshes if needed,
      // and the refresh either succeeds (token valid) or throws with
      // a recognizable error if the refresh_token is dead.
      await getValidToken(c.id, service as any);
      // Re-read the row to capture the new expiry (getValidToken writes
      // it back to client_links on successful refresh).
      const { data: fresh } = await service
        .from("client_links")
        .select("qbo_token_expires_at")
        .eq("id", c.id)
        .single();
      results.push({
        client_link_id: c.id,
        client_name: c.client_name,
        qbo_realm_id: c.qbo_realm_id,
        status: "ok",
        detail: "Refresh succeeded.",
        new_expiry: (fresh as any)?.qbo_token_expires_at || null,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/invalid_grant|invalid_token|token.*revoked|Incorrect Token type/i.test(msg)) {
        results.push({
          client_link_id: c.id,
          client_name: c.client_name,
          qbo_realm_id: c.qbo_realm_id,
          status: "invalid_grant",
          detail: "Refresh token dead — client must re-authorize QBO.",
          new_expiry: null,
        });
      } else {
        results.push({
          client_link_id: c.id,
          client_name: c.client_name,
          qbo_realm_id: c.qbo_realm_id,
          status: "other_error",
          detail: msg.slice(0, 300),
          new_expiry: null,
        });
      }
    }

    // QBO rate limit is ~500/min/realm but we're hitting different
    // realms across the loop. Tiny delay to stay polite to the OAuth
    // refresh endpoint specifically (separate quota).
    await new Promise((r) => setTimeout(r, 150));
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    invalid_grant: results.filter((r) => r.status === "invalid_grant").length,
    no_realm: results.filter((r) => r.status === "no_realm").length,
    other_error: results.filter((r) => r.status === "other_error").length,
    checked_at: new Date().toISOString(),
  };

  // Sort: dead connections first, then errors, then ok.
  results.sort((a, b) => {
    const rank = (s: ClientResult["status"]) =>
      s === "invalid_grant" ? 0 : s === "other_error" ? 1 : s === "no_realm" ? 2 : 3;
    return rank(a.status) - rank(b.status);
  });

  return NextResponse.json({ summary, results });
}
