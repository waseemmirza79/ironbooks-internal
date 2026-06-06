const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface PortalRecipient {
  email: string;
  firstName: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function firstNameFrom(fullName: string | null | undefined, fallback = "there"): string {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0] || fallback;
}

/**
 * All active portal users for a client, deduped by email.
 * Falls back to client_links.client_email when no portal users exist.
 */
export async function getPortalRecipients(
  service: Service,
  clientLinkId: string
): Promise<PortalRecipient[]> {
  const seen = new Set<string>();
  const out: PortalRecipient[] = [];

  function add(email: string | null | undefined, firstName: string) {
    if (!email) return;
    const norm = normalizeEmail(email);
    if (!EMAIL_RE.test(norm) || seen.has(norm)) return;
    seen.add(norm);
    out.push({ email: norm, firstName });
  }

  const { data: links } = await (service.from("client_users" as any) as any)
    .select("user_id")
    .eq("client_link_id", clientLinkId)
    .eq("active", true);

  const userIds = ((links || []) as { user_id: string }[]).map((l) => l.user_id);

  if (userIds.length) {
    const { data: users } = await service
      .from("users")
      .select("email, full_name")
      .in("id", userIds);

    for (const u of (users || []) as { email: string | null; full_name: string | null }[]) {
      add(u.email, firstNameFrom(u.full_name));
    }
  }

  if (!out.length) {
    const { data: client } = await service
      .from("client_links")
      .select("client_email, client_name")
      .eq("id", clientLinkId)
      .single();
    add(
      client?.client_email,
      firstNameFrom(client?.client_name, "there")
    );
  }

  return out;
}
