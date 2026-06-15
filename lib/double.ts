/**
 * Double HQ API Client (formerly Keeper)
 * --------------------------------------
 * Base URL:        https://api.doublehq.com
 * Auth:            OAuth2 client_credentials → bearer token (24hr cache)
 * Token endpoint:  POST /oauth/token
 * API paths:       all under /api/...
 * Rate limit:      300 req / 5min rolling window per OAuth client
 *
 * Required env vars:
 *   DOUBLE_CLIENT_ID
 *   DOUBLE_CLIENT_SECRET
 *   DOUBLE_BASE_URL (default: https://api.doublehq.com)
 *
 * Built against Double API 1.0.0 (OAS 3.0).
 */

const DEFAULT_BASE = "https://api.doublehq.com";
const BASE = process.env.DOUBLE_BASE_URL || DEFAULT_BASE;

/**
 * Hard ceiling on any single Double HTTP call. Without it, a Double
 * endpoint that accepts the connection but never responds hangs forever.
 * In reclass discovery's account-fetch phase, getClientEndCloses() runs
 * with no timeout and no heartbeat — a hung Double call there stalls the
 * whole job silently until the 15-min watchdog (the "stuck at Fetching
 * chart of accounts" symptom). 30s turns that into a fast, catchable error
 * that the calling try/catch already degrades gracefully (doubleCloses=[]).
 */
const DOUBLE_REQUEST_TIMEOUT_MS = 30_000;

// ============== TYPES ==============

/** From GET /api/clients — the paginated list endpoint returns this sparse shape */
export interface DoubleClientSummary {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  branchId: number;
}

/** From GET /api/clients/{clientId}/details — richer shape (not yet schema-verified) */
export interface DoubleClientDetails extends DoubleClientSummary {
  primary_email?: string;
  address_state?: string;
  status?: string;
  [key: string]: unknown;
}

/** From GET /api/end-closes/summary/ and webhook payloads */
export interface DoubleEndCloseSummary {
  id: number;
  status: string;           // e.g. "notStarted" — full enum TBD empirically
  yearMonth: string;        // "YYYYMM" — note: no separator (e.g., "202409")
  preparer: DoubleUser;
  reviewer: DoubleUser;
  manager: DoubleUser;
  dueDate: string | null;
  progress: string;         // pre-formatted percentage (e.g. "0.00%")
  clientId: number;
  clientName: string;
}

export interface DoubleUser {
  id: number;
  name: string;
  email: string;
}

/** From POST /api/non-closing-tasks */
export interface DoubleTaskCreate {
  clientId: number;
  taskName: string;
  dueDate: string;          // YYYY-MM-DD
  priority?: boolean;
  emailId?: string;
  assignedTo?: number;
  type?: "nonClosing";
  tagId?: string;
  status?: string;
  subText?: string;
}

export interface DoubleTaskResponse {
  id: number;
  name: string;
  subText?: string;
  status: string;
  priority: boolean;
  dueDate: string;
  assignedTo?: number;
  clientId: number;
  practiceId: number;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Webhook event types — full enum from Double schema */
export type DoubleHookType =
  | "endCloseStatusUpdates"
  | "clientPropertiesUpdates"
  | "taskStatusUpdates"
  | "clientPortalPostCreation"
  | "commentCreation"
  | "clientCreation";

export interface DoubleHookSubscription {
  id: number;
  url: string;
  type: DoubleHookType;
  practiceId: number;
}

// ============== TOKEN CACHE ==============
// In-memory per server instance. Survives across requests within the same Node process.
// On Vercel, each cold start starts fresh — fine because tokens are 24hr.

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

/**
 * Get a valid Double access token, fetching a new one if cache is empty/expired.
 * Reserves a 60-second buffer before expiry to avoid edge-case failures.
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.DOUBLE_CLIENT_ID;
  const clientSecret = process.env.DOUBLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Double API credentials missing. Set DOUBLE_CLIENT_ID and DOUBLE_CLIENT_SECRET in environment."
    );
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  let res: Response;
  try {
    res = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(DOUBLE_REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`Double OAuth token request timed out after ${DOUBLE_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Double OAuth token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("Double OAuth response missing access_token");
  }

  // Docs say tokens last 24hrs. Use expires_in if present, otherwise default to 23hrs to be safe.
  const ttlSeconds = data.expires_in || 23 * 3600;
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + ttlSeconds * 1000,
  };

  return data.access_token;
}

// ============== RATE LIMITER ==============
// Simple in-memory sliding window: 300 req per 5 minutes per process.
// Production-grade rate limiting would use Redis. This is fine for now since
// we're a single Vercel instance and far below the limit in normal operation.

const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const requestTimestamps: number[] = [];

async function rateLimit(): Promise<void> {
  const now = Date.now();
  // Drop timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) {
    const waitMs = requestTimestamps[0] + RATE_WINDOW_MS - now;
    console.warn(`Double rate limit reached; pausing ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs + 50));
  }
  requestTimestamps.push(now);
}

// ============== CORE REQUEST HELPER ==============

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
}

async function doubleRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  await rateLimit();
  const token = await getAccessToken();

  // Build URL with query string
  let url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  }

  const init: RequestInit = {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  init.signal = AbortSignal.timeout(DOUBLE_REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `Double API timed out after ${DOUBLE_REQUEST_TIMEOUT_MS / 1000}s on ${path} — Double did not respond.`
      );
    }
    throw err;
  }

  // Handle 401: token might have been revoked mid-cache. Clear and retry once.
  if (res.status === 401 && tokenCache) {
    tokenCache = null;
    return doubleRequest<T>(path, opts);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Double API ${res.status} on ${path}: ${text}`);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ============== CLIENTS ==============

/**
 * GET /api/clients
 * Returns paginated list. Max 100 per page (API hard limit).
 *
 * If you need all clients across pages, use listAllClients() instead.
 */
export async function listClients(params: {
  limit?: number;            // 1-100, default 50
  offset?: number;
  name?: string;             // case-insensitive partial match
  ids?: number[];            // filter to specific IDs
} = {}): Promise<DoubleClientSummary[]> {
  const limit = Math.min(params.limit || 50, 100);
  return doubleRequest<DoubleClientSummary[]>("/api/clients", {
    query: {
      limit,
      offset: params.offset || 0,
      name: params.name,
      id: params.ids?.join(","),
    },
  });
}

/**
 * Fetch ALL clients across all pages.
 * Use sparingly — for a practice with 500 clients this is 5 sequential calls.
 */
export async function listAllClients(): Promise<DoubleClientSummary[]> {
  const all: DoubleClientSummary[] = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const page = await listClients({ limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/**
 * GET /api/clients/{clientId}/details
 * Returns richer client info (schema not yet fully verified).
 */
export async function getClientDetails(clientId: number): Promise<DoubleClientDetails> {
  return doubleRequest<DoubleClientDetails>(`/api/clients/${clientId}/details`);
}

// ============== END CLOSES ==============

/**
 * GET /api/end-closes/summary/
 * Returns end closes ordered by clientId and yearMonth.
 * Used by reclass engine to skip transactions in closed periods.
 */
export async function listEndCloses(): Promise<DoubleEndCloseSummary[]> {
  return doubleRequest<DoubleEndCloseSummary[]>("/api/end-closes/summary/");
}

/**
 * GET /api/clients/{clientId}/end-closes
 * Returns close periods for a specific client.
 */
export async function getClientEndCloses(clientId: number): Promise<DoubleEndCloseSummary[]> {
  return doubleRequest<DoubleEndCloseSummary[]>(`/api/clients/${clientId}/end-closes`);
}

/**
 * Check if a given date falls within a closed period for a client.
 * Returns the matching close summary if found, null otherwise.
 *
 * Used by reclass engine: every transaction's date is checked against this.
 * yearMonth format from Double: "YYYYMM" (e.g. "202409" = September 2024).
 */
export async function findCloseForDate(
  clientId: number,
  date: string | Date,
  closesCache?: DoubleEndCloseSummary[]
): Promise<DoubleEndCloseSummary | null> {
  const d = typeof date === "string" ? new Date(date) : date;
  const yearMonth = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const closes = closesCache || (await getClientEndCloses(clientId));
  return closes.find((c) => c.yearMonth === yearMonth) || null;
}

// ============== TASKS ==============

/**
 * POST /api/non-closing-tasks
 * Creates a custom (non-closing) task in Double.
 *
 * Use this to post Ironbooks work-product into Lisa's task board:
 *   - "Cleanup complete: 247 transactions reclassified"
 *   - "Bank rules pushed: 18 new rules active"
 */
export async function createTask(task: DoubleTaskCreate): Promise<DoubleTaskResponse> {
  return doubleRequest<DoubleTaskResponse>("/api/non-closing-tasks", {
    method: "POST",
    body: {
      clientId: task.clientId,
      taskName: task.taskName,
      dueDate: task.dueDate,
      priority: task.priority ?? false,
      emailId: task.emailId || "",
      assignedTo: task.assignedTo ?? 0,
      type: task.type || "nonClosing",
      tagId: task.tagId || "",
      status: task.status || "notStarted",
      subText: task.subText || "",
    },
  });
}

// ============== WEBHOOK SUBSCRIPTIONS ==============

/**
 * POST /api/hook-subscriptions
 * Subscribe to a Double event type. Double will POST to your URL when the event fires.
 *
 * Note: Some accounts may get 403 if practice doesn't have webhook permissions.
 */
export async function subscribeWebhook(
  url: string,
  type: DoubleHookType
): Promise<DoubleHookSubscription> {
  return doubleRequest<DoubleHookSubscription>("/api/hook-subscriptions", {
    method: "POST",
    body: { url, type },
  });
}

/** GET /api/hook-subscriptions */
export async function listWebhooks(): Promise<DoubleHookSubscription[]> {
  return doubleRequest<DoubleHookSubscription[]>("/api/hook-subscriptions");
}

/** DELETE /api/hook-subscriptions/{hookId} */
export async function deleteWebhook(hookId: number): Promise<void> {
  await doubleRequest<void>(`/api/hook-subscriptions/${hookId}`, { method: "DELETE" });
}

// ============== HIGH-LEVEL CONVENIENCE ==============

/**
 * Post a "COA cleanup complete" task to Double for a given client.
 * Called by the executor at the end of a successful cleanup job.
 *
 * clientId comes in as string (from our client_links.double_client_id TEXT column)
 * — we cast to int at the boundary since Double's API expects numeric.
 */
export async function postCleanupComplete(
  doubleClientIdStr: string,
  stats: {
    accountsRenamed: number;
    accountsCreated: number;
    accountsDeleted: number;
    transactionsReclassified: number;
    bookkeeperName: string;
    durationSeconds: number;
  }
): Promise<DoubleTaskResponse | null> {
  // Skip if no real Double client linked (e.g., during sandbox testing)
  if (!doubleClientIdStr || doubleClientIdStr.startsWith("pending_")) {
    return null;
  }

  const clientId = parseInt(doubleClientIdStr, 10);
  if (isNaN(clientId)) {
    throw new Error(`Invalid Double clientId: "${doubleClientIdStr}" is not numeric`);
  }

  const totalChanges =
    stats.accountsRenamed + stats.accountsCreated + stats.accountsDeleted;
  const today = new Date().toISOString().split("T")[0];

  const minutes = Math.round(stats.durationSeconds / 60);
  const durationStr = minutes >= 1 ? `${minutes}m` : `${stats.durationSeconds}s`;

  const subText = [
    `Ironbooks COA cleanup complete by ${stats.bookkeeperName}.`,
    "",
    `• Accounts renamed: ${stats.accountsRenamed}`,
    `• Accounts created: ${stats.accountsCreated}`,
    `• Accounts inactivated: ${stats.accountsDeleted}`,
    stats.transactionsReclassified > 0
      ? `• Transactions reclassified: ${stats.transactionsReclassified}`
      : null,
    "",
    `Duration: ${durationStr}`,
  ]
    .filter(Boolean)
    .join("\n");

  return createTask({
    clientId,
    taskName: `Ironbooks: COA cleanup complete (${totalChanges} changes)`,
    dueDate: today,
    priority: false,
    type: "nonClosing",
    subText,
  });
}

/**
 * Post a "Reclassification complete" task to Double.
 * Used by reclass engine (Sprint A, coming next).
 */
export async function postReclassComplete(
  doubleClientIdStr: string,
  stats: {
    sourceAccount: string;
    targetAccount?: string;
    transactionsMoved: number;
    transactionsSkipped: number;
    bookkeeperName: string;
    reason: string;
    dateRangeStart: string;
    dateRangeEnd: string;
  }
): Promise<DoubleTaskResponse | null> {
  if (!doubleClientIdStr || doubleClientIdStr.startsWith("pending_")) {
    return null;
  }

  const clientId = parseInt(doubleClientIdStr, 10);
  if (isNaN(clientId)) {
    throw new Error(`Invalid Double clientId: "${doubleClientIdStr}"`);
  }

  const today = new Date().toISOString().split("T")[0];
  const targetClause = stats.targetAccount ? ` → ${stats.targetAccount}` : "";

  const subText = [
    `Ironbooks reclassification complete by ${stats.bookkeeperName}.`,
    "",
    `Source: ${stats.sourceAccount}${targetClause}`,
    `Date range: ${stats.dateRangeStart} to ${stats.dateRangeEnd}`,
    `Reason: ${stats.reason}`,
    "",
    `• Transactions moved: ${stats.transactionsMoved}`,
    stats.transactionsSkipped > 0
      ? `• Transactions skipped: ${stats.transactionsSkipped}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return createTask({
    clientId,
    taskName: `Ironbooks: ${stats.transactionsMoved} txs reclassified${targetClause}`,
    dueDate: today,
    priority: false,
    type: "nonClosing",
    subText,
  });
}

// ============== SMART MATCH (existing helper) ==============

/**
 * Score a QBO client against a list of Double clients to find best match.
 * Used by the Double matcher UI after QBO connect.
 *
 * Note: As of Double API 1.0.0, the list endpoint only returns {id, name, createdAt,
 * updatedAt, branchId} — no email or state. So this match is name-only for now.
 * If we need richer matching, fetch /clients/{id}/details for the top candidates.
 */
export function suggestMatch(
  qboClient: { name: string; email?: string; state?: string },
  doubleClients: DoubleClientSummary[]
): { client: DoubleClientSummary; score: number } | null {
  if (doubleClients.length === 0) return null;

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\b(inc|llc|ltd|corp|co|company|the)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const qboName = normalize(qboClient.name);
  let best: { client: DoubleClientSummary; score: number } | null = null;

  for (const dc of doubleClients) {
    const dName = normalize(dc.name);
    let score = 0;

    if (dName === qboName) {
      score = 1.0;
    } else if (dName.includes(qboName) || qboName.includes(dName)) {
      score = 0.8;
    } else {
      // Token-overlap fallback
      const qboTokens = new Set(qboName.split(" ").filter((t) => t.length > 2));
      const dTokens = new Set(dName.split(" ").filter((t) => t.length > 2));
      const overlap = [...qboTokens].filter((t) => dTokens.has(t)).length;
      const denom = Math.max(qboTokens.size, dTokens.size);
      score = denom > 0 ? overlap / denom : 0;
    }

    if (score > (best?.score || 0)) {
      best = { client: dc, score };
    }
  }

  return best && best.score >= 0.5 ? best : null;
}

// ============== DEBUG/INTROSPECTION ==============

/**
 * Returns current token cache state — useful for the /api/double/test endpoint.
 * Does NOT expose the actual token value.
 */
export function getAuthStatus(): {
  cached: boolean;
  expiresInSeconds: number | null;
  baseUrl: string;
  hasCredentials: boolean;
} {
  return {
    cached: tokenCache !== null,
    expiresInSeconds: tokenCache
      ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000))
      : null,
    baseUrl: BASE,
    hasCredentials:
      !!process.env.DOUBLE_CLIENT_ID && !!process.env.DOUBLE_CLIENT_SECRET,
  };
}

/** Force-clear the token cache. Useful if you rotate credentials. */
export function clearTokenCache(): void {
  tokenCache = null;
}
