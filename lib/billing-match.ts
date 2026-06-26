/**
 * Client matching index for billing — maps a Stripe charge's customer/email to a
 * SNAP client. Critically, it indexes BOTH client_links.client_email AND every
 * portal-login email (client_users → users.email), because the person who pays
 * on Stripe is usually the portal user, not the address stored on client_links.
 * Also supports 95% fuzzy matching on email + company/contact name.
 */
export interface ClientIndex {
  byEmail: Map<string, string>;       // email (lower) → client_link_id
  byCustomer: Map<string, string>;    // stripe_customer_id → client_link_id
  clients: { id: string; company: string; emails: string[]; nameNorm: string }[];
}

const normName = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function similarity(a: string, b: string): number {
  a = (a || "").toLowerCase().trim(); b = (b || "").toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export async function buildClientIndex(service: any): Promise<ClientIndex> {
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, contact_first_name, contact_last_name, client_email, stripe_customer_id")
    .eq("is_active", true);

  // Portal-login emails per client (the address that usually pays on Stripe).
  const { data: maps } = await service.from("client_users").select("client_link_id, user_id").eq("active", true);
  const userIds = [...new Set(((maps as any[]) || []).map((m) => m.user_id))];
  const emailByUser = new Map<string, string>();
  if (userIds.length) {
    const { data: users } = await service.from("users").select("id, email").in("id", userIds);
    for (const u of ((users as any[]) || [])) if (u.email) emailByUser.set(u.id, u.email.toLowerCase());
  }
  const portalEmailsByClient = new Map<string, string[]>();
  for (const m of ((maps as any[]) || [])) {
    const e = emailByUser.get(m.user_id);
    if (!e) continue;
    const arr = portalEmailsByClient.get(m.client_link_id) || [];
    arr.push(e); portalEmailsByClient.set(m.client_link_id, arr);
  }

  const byEmail = new Map<string, string>();
  const byCustomer = new Map<string, string>();
  const out: ClientIndex["clients"] = [];
  for (const c of ((clients as any[]) || [])) {
    const emails = new Set<string>();
    if (c.client_email) emails.add(String(c.client_email).toLowerCase());
    for (const e of (portalEmailsByClient.get(c.id) || [])) emails.add(e);
    for (const e of emails) if (!byEmail.has(e)) byEmail.set(e, c.id);
    if (c.stripe_customer_id) byCustomer.set(c.stripe_customer_id, c.id);
    out.push({
      id: c.id,
      company: c.legal_business_name || c.client_name || "—",
      emails: [...emails],
      nameNorm: normName(c.legal_business_name || c.client_name) + " " + normName(`${c.contact_first_name || ""}${c.contact_last_name || ""}`),
    });
  }
  return { byEmail, byCustomer, clients: out };
}

export interface MatchSuggestion { clientLinkId: string; company: string; score: number; reason: string }

/** Best client for a charge's email / customer-name. Exact email → 1.0; else
 *  fuzzy email or name ≥ 0.95. Returns null when nothing is confident. */
export function suggestClient(index: ClientIndex, email: string | null, name: string | null): MatchSuggestion | null {
  if (email) {
    const e = email.toLowerCase().trim();
    const exact = index.byEmail.get(e);
    if (exact) {
      const c = index.clients.find((x) => x.id === exact);
      return { clientLinkId: exact, company: c?.company || "—", score: 1, reason: "exact email (portal/billing)" };
    }
    let best: MatchSuggestion | null = null;
    for (const c of index.clients) {
      for (const ce of c.emails) {
        const s = similarity(e, ce);
        if (s >= 0.95 && (!best || s > best.score)) best = { clientLinkId: c.id, company: c.company, score: s, reason: `~email ${(s * 100).toFixed(0)}%` };
      }
    }
    if (best) return best;
  }
  if (name) {
    const n = normName(name);
    let best: MatchSuggestion | null = null;
    for (const c of index.clients) {
      const s = similarity(n, c.nameNorm);
      if (s >= 0.95 && (!best || s > best.score)) best = { clientLinkId: c.id, company: c.company, score: s, reason: `~name ${(s * 100).toFixed(0)}%` };
    }
    if (best) return best;
  }
  return null;
}
