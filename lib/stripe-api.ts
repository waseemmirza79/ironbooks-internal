/**
 * Stripe API helpers for connected accounts (OAuth Connect Standard).
 *
 * Uses the per-client access_token saved on client_links.stripe_access_token
 * during the OAuth flow. All requests go to the platform's Stripe URL with
 * the connected account's access token in the Authorization header.
 *
 * Scope: minimal surface needed for AR reconciliation —
 *   - List payouts in a date range
 *   - List the balance transactions (charges + fees) inside a payout
 *   - Look up a charge (for customer email, metadata, invoice link)
 *
 * NOTE: We do NOT use the platform's secret key with stripe-account header
 * here — that's the Standard Connect alternative. We use the saved
 * access_token directly, which is simpler and works for read access.
 */

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripePayout {
  id: string;
  amount: number;           // net cents paid out to bank
  currency: string;
  arrival_date: number;     // unix epoch seconds
  created: number;          // unix epoch seconds
  status: string;
  method: string;           // standard / instant
  type: string;             // bank_account / card
  description: string | null;
}

export interface StripeBalanceTransaction {
  id: string;
  amount: number;           // gross cents
  fee: number;              // fee cents
  net: number;              // net cents
  currency: string;
  type: string;             // 'charge' | 'refund' | 'payout' | 'stripe_fee' | ...
  source: string | null;    // related object id (e.g. charge id)
  description: string | null;
  created: number;
}

export interface StripeCharge {
  id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  customer: string | null;        // customer id (cus_xxx)
  receipt_email: string | null;
  description: string | null;
  invoice: string | null;          // Stripe invoice id (in_xxx) if any
  billing_details: {
    name: string | null;
    email: string | null;
  };
  metadata: Record<string, string>;
  created: number;
}

interface ListOptions {
  starting_after?: string;
  limit?: number;
}

async function stripeFetch<T>(
  path: string,
  accessToken: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${STRIPE_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Stripe-Version": "2024-04-10",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe API ${res.status} at ${path}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * List every payout that arrived in [arrivalStartISO, arrivalEndISO]. We
 * filter by `arrival_date` (not `created`) because that's when the funds
 * land in the bank — i.e. when QBO records the matching Deposit.
 */
export async function listPayoutsInRange(
  accessToken: string,
  arrivalStartISO: string,
  arrivalEndISO: string
): Promise<StripePayout[]> {
  const startUnix = Math.floor(new Date(arrivalStartISO).getTime() / 1000);
  // include the entire end day
  const endUnix = Math.floor(new Date(arrivalEndISO).getTime() / 1000) + 86400;

  const all: StripePayout[] = [];
  let startingAfter: string | undefined;
  // Hard cap iterations as a safety net against runaway loops
  for (let i = 0; i < 50; i++) {
    const data = await stripeFetch<{ data: StripePayout[]; has_more: boolean }>(
      "/payouts",
      accessToken,
      {
        "arrival_date[gte]": startUnix,
        "arrival_date[lt]": endUnix,
        limit: 100,
        starting_after: startingAfter,
      } as any
    );
    all.push(...data.data);
    if (!data.has_more || data.data.length === 0) break;
    startingAfter = data.data[data.data.length - 1].id;
  }
  return all;
}

/**
 * List balance transactions (charges + fees + refunds) that compose a payout.
 * Pass `payout` param so Stripe scopes the results.
 */
export async function listBalanceTransactionsForPayout(
  accessToken: string,
  payoutId: string
): Promise<StripeBalanceTransaction[]> {
  const all: StripeBalanceTransaction[] = [];
  let startingAfter: string | undefined;
  for (let i = 0; i < 50; i++) {
    const data = await stripeFetch<{
      data: StripeBalanceTransaction[];
      has_more: boolean;
    }>("/balance_transactions", accessToken, {
      payout: payoutId,
      limit: 100,
      starting_after: startingAfter,
    });
    all.push(...data.data);
    if (!data.has_more || data.data.length === 0) break;
    startingAfter = data.data[data.data.length - 1].id;
  }
  return all;
}

/**
 * Retrieve a single charge by id. Used to enrich a balance transaction
 * (which only has source=ch_xxx) with customer email + description.
 */
export async function getCharge(
  accessToken: string,
  chargeId: string
): Promise<StripeCharge> {
  return stripeFetch<StripeCharge>(`/charges/${chargeId}`, accessToken);
}
