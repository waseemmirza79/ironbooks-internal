/**
 * Stripe OAuth Connect
 * ─────────────────────
 * Standard OAuth flow. Client clicks our branded landing page, hits Stripe's
 * auth screen, approves, redirects back to our callback with a code we
 * exchange for a long-lived access token.
 *
 * Scope: `read_write` — Stripe no longer auto-approves `read_only` for new
 * Connect platforms (requires a support ticket). We use read_write but our
 * code only ever calls read endpoints (payouts, charges, balance transactions).
 * We can switch to read_only later by emailing Stripe support to enable it.
 *
 * Required env vars (set in Vercel):
 *   STRIPE_CONNECT_CLIENT_ID  — platform Connect Client ID (ca_xxx)
 *   STRIPE_SECRET_KEY         — platform secret key (sk_xxx, restricted is fine)
 *   NEXT_PUBLIC_BASE_URL      — https://internal.ironbooks.com
 */

const STRIPE_OAUTH_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const STRIPE_OAUTH_TOKEN = "https://connect.stripe.com/oauth/token";
const STRIPE_OAUTH_DEAUTHORIZE = "https://connect.stripe.com/oauth/deauthorize";

export interface StripeOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  stripe_user_id: string;     // acct_xxx — the connected account ID
  scope: string;
  token_type: string;
  livemode: boolean;
  stripe_publishable_key?: string;
}

/**
 * Build the URL the client gets sent to when they click "Connect with Stripe".
 * We pass `state` = the connect-token from our DB so the callback can identify
 * which client_link the connection belongs to.
 */
export function buildStripeAuthorizeUrl(params: {
  state: string;
  /** Pre-fill business name on Stripe's screen (optional, just for UX) */
  suggestedCompany?: string;
}): string {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) {
    throw new Error("STRIPE_CONNECT_CLIENT_ID env var is not set");
  }
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
  const redirectUri = `${baseUrl}/api/stripe/oauth/callback`;

  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    redirect_uri: redirectUri,
    state: params.state,
    // Land on the login screen by default — our clients already have Stripe
    // accounts. They can switch to "create account" from there if they're new.
    stripe_landing: "login",
  });
  if (params.suggestedCompany) {
    query.set("stripe_user[business_name]", params.suggestedCompany);
  }

  return `${STRIPE_OAUTH_AUTHORIZE}?${query.toString()}`;
}

/**
 * Exchange the authorization code (returned to our callback) for access tokens.
 * Called server-side from the OAuth callback handler.
 */
export async function exchangeCodeForTokens(code: string): Promise<StripeOAuthTokenResponse> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY env var is not set");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
  });

  const res = await fetch(STRIPE_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe OAuth token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as StripeOAuthTokenResponse;
  if (!data.access_token || !data.stripe_user_id) {
    throw new Error("Stripe OAuth response missing access_token or stripe_user_id");
  }
  return data;
}

/**
 * Revoke our access to a connected Stripe account. Calls Stripe's
 * /oauth/deauthorize endpoint with the platform secret key. After this,
 * the access_token we stored is invalidated and the client also sees
 * Ironbooks removed from their Stripe Dashboard's Connected applications.
 *
 * Safe to call even if Stripe-side state is out of sync — we treat
 * "account already not connected" as a success.
 */
export async function deauthorizeStripeAccount(stripeUserId: string): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!secret) throw new Error("STRIPE_SECRET_KEY env var is not set");
  if (!clientId) throw new Error("STRIPE_CONNECT_CLIENT_ID env var is not set");

  const body = new URLSearchParams({
    client_id: clientId,
    stripe_user_id: stripeUserId,
  });

  const res = await fetch(STRIPE_OAUTH_DEAUTHORIZE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    // Stripe returns 400 with error_code=application_not_authorized if the
    // account is already disconnected — that's still success for our purposes.
    if (text.includes("application_not_authorized")) return;
    throw new Error(`Stripe OAuth deauthorize failed (${res.status}): ${text}`);
  }
}

/**
 * Generate a cryptographically random URL-safe token string for the connect
 * token's URL slug. 32 bytes = ~43 base64url characters — plenty of entropy.
 */
export function generateConnectToken(): string {
  // Browser-safe in Node 18+ and runtime environments
  const bytes = new Uint8Array(32);
  // @ts-ignore — crypto is globally available in Node 18+ and the Edge runtime
  (globalThis.crypto || require("crypto")).getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
