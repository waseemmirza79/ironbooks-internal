import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, QBOReauthRequiredError } from "@/lib/qbo";

/**
 * GET /api/internal/qbo-token/[client_link_id]
 *
 * Internal-use endpoint that vends a valid QBO access token + realm id
 * for a client. Coach-Intel (and any other sibling project sharing the
 * Supabase) calls THIS instead of refreshing tokens directly. The whole
 * point is to centralize token issuance in Ironbooks so only one service
 * ever calls Intuit's /oauth2/v1/tokens endpoint — eliminating the
 * one-time-use refresh-token rotation race that killed 32 of our 62
 * client connections by 2026-06-08.
 *
 * Auth: shared secret in the `X-Internal-Secret` header, must match
 * env INTERNAL_API_SECRET. Set this env var on both Ironbooks (this
 * project) and coach-intel; rotate it if it ever leaks.
 *
 * Response shape (success, 200):
 *   {
 *     access_token: string,     // valid for at least 5 minutes
 *     realm_id: string,
 *     expires_at: string,       // ISO 8601, when the access token expires
 *     refreshed: boolean        // true if we just rotated; false = cached
 *   }
 *
 * Response shape (dead refresh token, 401):
 *   {
 *     error: "qbo_reauth_required",
 *     reconnect_url: string,
 *     client_link_id: string
 *   }
 *
 * The lock + log infrastructure in lib/qbo.ts ensures concurrent calls
 * for the same client serialize (no race even under load) and every
 * attempt is recorded in qbo_refresh_log with source='external-api'.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: Request,
  context: { params: Promise<{ client_link_id: string }> }
) {
  // ── Auth: shared secret header ──
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "INTERNAL_API_SECRET not configured on this deployment" },
      { status: 500 }
    );
  }
  const provided = request.headers.get("x-internal-secret");
  if (!provided || provided !== expected) {
    // Don't echo back what was expected — just say no.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { client_link_id } = await context.params;
  if (!client_link_id) {
    return NextResponse.json(
      { error: "client_link_id required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, qbo_token_expires_at")
    .eq("id", client_link_id)
    .single();
  if (!client) {
    return NextResponse.json(
      { error: "Client not found" },
      { status: 404 }
    );
  }
  const realmId = (client as any).qbo_realm_id as string | null;
  if (!realmId) {
    return NextResponse.json(
      {
        error: "Client has no QBO connection. Onboard QBO first via the Ironbooks UI.",
      },
      { status: 400 }
    );
  }

  // Identify the caller for the refresh log. Coach-intel can pass
  // `X-Source-App` (or we default to "external-api" if missing) so the
  // log is debuggable.
  const sourceApp =
    request.headers.get("x-source-app") ||
    request.headers.get("user-agent") ||
    "external-api";
  const source = `external-api/${sourceApp.slice(0, 80)}`;

  // Note whether the token was already valid pre-call (no refresh needed)
  // so we can echo `refreshed` in the response. getValidToken's fast path
  // never touches Intuit when the cached token has >5 min of life left.
  const preExpiresAt = (client as any).qbo_token_expires_at;
  const willRefresh =
    !preExpiresAt ||
    new Date(preExpiresAt).getTime() < Date.now() + 5 * 60 * 1000;

  try {
    const accessToken = await getValidToken(
      client_link_id,
      service as any,
      source
    );
    // Re-read for the fresh expires_at after potential refresh.
    const { data: fresh } = await service
      .from("client_links")
      .select("qbo_token_expires_at")
      .eq("id", client_link_id)
      .single();
    return NextResponse.json(
      {
        access_token: accessToken,
        realm_id: realmId,
        expires_at: (fresh as any)?.qbo_token_expires_at || null,
        refreshed: willRefresh,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          // Helps debugging: callers can see which secret tier they hit.
          "X-Token-Source": "vending",
        },
      }
    );
  } catch (err: any) {
    if (err instanceof QBOReauthRequiredError) {
      return NextResponse.json(
        {
          error: "qbo_reauth_required",
          reconnect_url: err.reconnectUrl,
          client_link_id,
        },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: err?.message || "QBO token fetch failed" },
      { status: 500 }
    );
  }
}
