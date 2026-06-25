import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Onboarding lead → existing client matching.
 *
 * GHL feeds onboarding_leads from "won" opportunities. Some of those wins are
 * businesses that are ALREADY clients (a re-sale, an upsell, or a backfill of
 * historical wins). Without a match against client_links those leads sit
 * forever in the "New sale" column even though the client is already in
 * cleanup/production. This helper finds the existing client so the lead can be
 * auto-converted+linked instead.
 *
 * Conservative by design: EXACT email or EXACT normalized-name only, and only
 * when there is exactly ONE active candidate. Never fuzzy — a wrong auto-link
 * would hide a genuine new sale. Ambiguous/near cases are left on the board for
 * a human to link.
 */

const SUFFIX_RE =
  /\b(llc|inc|ltd|corp|co|company|the|painting|paint|painters?|services?|group|enterprises?)\b/g;

export function normalizeBusinessName(s: string | null | undefined): string {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const emailKey = (s: string | null | undefined) => (s || "").toString().trim().toLowerCase();

export interface LeadIdentity {
  email?: string | null;
  business_name?: string | null;
  full_name?: string | null;
}

export interface ClientMatch {
  id: string;
  client_name: string;
  method: "email" | "name";
}

/**
 * Find the single existing active client_link that this lead clearly already
 * is. Returns null when there's no match or more than one candidate (ambiguous).
 */
export async function findExistingClientForLead(
  service: SupabaseClient,
  lead: LeadIdentity
): Promise<ClientMatch | null> {
  const { data: clients } = await (service as any)
    .from("client_links")
    .select("id, client_name, legal_business_name, double_client_name, client_email, is_active");

  const active = ((clients as any[]) || []).filter((c) => c.is_active !== false);
  if (active.length === 0) return null;

  // 1. Exact email — the most reliable signal.
  const e = emailKey(lead.email);
  if (e) {
    const hits = active.filter((c) => emailKey(c.client_email) === e);
    const ids = [...new Set(hits.map((c) => c.id))];
    if (ids.length === 1) {
      const c = hits.find((x) => x.id === ids[0])!;
      return { id: c.id, client_name: c.client_name, method: "email" };
    }
    if (ids.length > 1) return null; // ambiguous email — leave for a human
  }

  // 2. Exact normalized business/contact name.
  const n = normalizeBusinessName(lead.business_name) || normalizeBusinessName(lead.full_name);
  if (n && n.length >= 3) {
    const hits = active.filter((c) =>
      [c.client_name, c.legal_business_name, c.double_client_name]
        .some((nm) => normalizeBusinessName(nm) === n)
    );
    const ids = [...new Set(hits.map((c) => c.id))];
    if (ids.length === 1) {
      const c = hits.find((x) => x.id === ids[0])!;
      return { id: c.id, client_name: c.client_name, method: "name" };
    }
  }

  return null;
}
