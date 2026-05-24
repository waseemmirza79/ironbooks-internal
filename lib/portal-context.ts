/**
 * Portal context helper — single source of truth for "which client is the
 * currently-logged-in portal user looking at, and what's their QBO access?"
 *
 * Every portal data fetcher calls resolvePortalContext() at the top. If the
 * user isn't a client, doesn't have an active mapping, or the mapped
 * client_link has no QBO connection, this throws — caught upstream by the
 * page-level error boundaries.
 *
 * This is defense-in-depth on top of the middleware role gate: even if a
 * client somehow lands on a portal API route, they can only ever access
 * their own client's QBO data because the access token is resolved
 * server-side from their user_id, not from any request parameter.
 */
import { createServerSupabase, createServiceSupabase } from "./supabase";
import { getValidToken } from "./qbo";

export interface PortalContext {
  userId: string;
  userEmail: string;
  userFullName: string;
  clientLinkId: string;
  clientName: string;
  qboRealmId: string;
  accessToken: string;
}

export class PortalAccessError extends Error {
  constructor(message: string, public code: "no_session" | "not_client" | "no_mapping" | "no_qbo" | "fetch_failed") {
    super(message);
    this.name = "PortalAccessError";
  }
}

/**
 * Resolve the portal user → client_link → QBO access token in one shot.
 * Throws PortalAccessError if any step fails; callers should catch it and
 * render an appropriate UI state.
 *
 * Uses the service-role client for the DB lookups so we don't depend on
 * per-row RLS policies — those will land later as part of the rollout but
 * this layer is the security boundary regardless.
 */
export async function resolvePortalContext(): Promise<PortalContext> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new PortalAccessError("Not signed in", "no_session");
  }

  const service = createServiceSupabase();

  // Confirm the user is actually a client
  const { data: profile } = await service
    .from("users")
    .select("role, email, full_name, is_active")
    .eq("id", user.id)
    .single();
  if ((profile as any)?.role !== "client") {
    throw new PortalAccessError("Not a portal user", "not_client");
  }
  if ((profile as any)?.is_active === false) {
    throw new PortalAccessError("Account is disabled", "not_client");
  }

  // Resolve the client mapping
  const { data: mapping } = await service
    .from("client_users" as any)
    .select("client_link_id, active")
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (!mapping || !(mapping as any).client_link_id) {
    throw new PortalAccessError("Portal access not provisioned", "no_mapping");
  }
  const clientLinkId = (mapping as any).client_link_id as string;

  // Pull the client details + ensure QBO is connected
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) {
    throw new PortalAccessError("Client not found", "no_mapping");
  }
  if ((client as any).is_active === false) {
    throw new PortalAccessError("Client is inactive", "no_mapping");
  }
  if (!(client as any).qbo_realm_id) {
    throw new PortalAccessError("QBO not connected for this client", "no_qbo");
  }

  // Get a fresh QBO access token. getValidToken handles refresh internally.
  let accessToken: string;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
  } catch (err: any) {
    throw new PortalAccessError(
      `QBO authorization failed: ${err?.message || "unknown"}`,
      "no_qbo"
    );
  }

  return {
    userId: user.id,
    userEmail: (profile as any).email || user.email || "",
    userFullName: (profile as any).full_name || "",
    clientLinkId,
    clientName: (client as any).client_name || "Your Business",
    qboRealmId: (client as any).qbo_realm_id as string,
    accessToken,
  };
}

/**
 * Helper for the "not-yet-set-up" friendly states. Returns null if the
 * context resolves cleanly, or a structured error so pages can render
 * a useful message without crashing.
 */
export async function tryResolvePortalContext(): Promise<
  | { ok: true; ctx: PortalContext }
  | { ok: false; code: PortalAccessError["code"]; message: string }
> {
  try {
    const ctx = await resolvePortalContext();
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: "fetch_failed", message: (err as Error).message };
  }
}
