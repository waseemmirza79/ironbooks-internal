import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reclass → Bank Rules default targets.
 *
 * In the cleanup workflow the bookkeeper reclassifies transactions (Step 2)
 * before discovering bank rules (Step 3). The two steps share the SAME vendor
 * normalizer — `normalizeVendorName` is byte-for-byte identical in
 * `lib/qbo-rules.ts` (which sets `bank_rules.vendor_pattern`) and
 * `lib/qbo-reclass.ts` (which sets `reclassifications.vendor_pattern_normalized`).
 * So `bank_rules.vendor_pattern` joins cleanly to
 * `reclassifications.vendor_pattern_normalized`.
 *
 * This helper builds, per normalized vendor pattern, the account that vendor
 * was reclassed to — preferring the bookkeeper's explicit override, then the
 * most-frequently-chosen target. That account becomes the auto-populated
 * default for the matching bank rule, so a rule defaults to the decision the
 * bookkeeper already made in reclass instead of a fresh independent AI guess.
 */

export type ReclassTarget = { id: string; name: string };

/**
 * Map of normalized vendor pattern → the account that vendor was reclassed to,
 * aggregated across ALL of the client's reclass jobs (vendor→account mappings
 * are stable for a given trade, and the most-frequent target wins ties toward
 * the bookkeeper's repeated decision).
 */
export async function buildReclassTargetMap(
  service: SupabaseClient,
  clientLinkId: string
): Promise<Map<string, ReclassTarget>> {
  const empty = new Map<string, ReclassTarget>();

  // reclassifications join the client via reclass_jobs.client_link_id.
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id")
    .eq("client_link_id", clientLinkId);

  const jobIds = ((jobs as { id: string }[]) || []).map((j) => j.id);
  if (jobIds.length === 0) return empty;

  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_pattern_normalized, vendor_name, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name"
    )
    .in("reclass_job_id", jobIds)
    .in("decision", ["auto_approve", "approved", "needs_review", "flagged", "ask_client"]);

  type Row = {
    vendor_pattern_normalized: string | null;
    vendor_name: string | null;
    to_account_id: string | null;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
  };

  // For each vendor, count how often each target account was chosen, and track
  // whether any row carried an explicit bookkeeper override (which wins).
  const perVendor = new Map<
    string,
    {
      counts: Map<string, { target: ReclassTarget; count: number }>;
      override: ReclassTarget | null;
    }
  >();

  for (const row of (rows || []) as Row[]) {
    const key = row.vendor_pattern_normalized || "";
    if (!key) continue;

    const overrideName = row.bookkeeper_override_target_name;
    const name = overrideName || row.to_account_name;
    if (!name) continue;
    const id = (overrideName ? row.bookkeeper_override_target_id : row.to_account_id) || "";

    if (!perVendor.has(key)) {
      perVendor.set(key, { counts: new Map(), override: null });
    }
    const entry = perVendor.get(key)!;

    if (overrideName) {
      // Latest explicit override wins — the bookkeeper deliberately picked this.
      entry.override = { id, name: overrideName };
    }

    const existing = entry.counts.get(name.toLowerCase());
    if (existing) existing.count += 1;
    else entry.counts.set(name.toLowerCase(), { target: { id, name }, count: 1 });
  }

  const result = new Map<string, ReclassTarget>();
  for (const [vendor, entry] of perVendor.entries()) {
    if (entry.override) {
      result.set(vendor, entry.override);
      continue;
    }
    let best: { target: ReclassTarget; count: number } | null = null;
    for (const c of entry.counts.values()) {
      if (!best || c.count > best.count) best = c;
    }
    if (best) result.set(vendor, best.target);
  }

  return result;
}
