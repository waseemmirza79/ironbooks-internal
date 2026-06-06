/**
 * CPA flag workflow — hard block until lead/admin sign-off.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function createCpaFlag(
  service: SupabaseClient,
  opts: {
    clientLinkId: string;
    runId: string;
    flagType: string;
    description: string;
    impactSummary?: string;
  }
): Promise<string> {
  const { data, error } = await service
    .from("cpa_flags")
    .insert({
      client_link_id: opts.clientLinkId,
      run_id: opts.runId,
      flag_type: opts.flagType,
      description: opts.description,
      impact_summary: opts.impactSummary || null,
      status: "open",
    } as any)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function signOffCpaFlag(
  service: SupabaseClient,
  flagId: string,
  userId: string,
  notes?: string
): Promise<void> {
  const { error } = await service
    .from("cpa_flags")
    .update({
      status: "signed_off",
      signed_off_by: userId,
      signed_off_at: new Date().toISOString(),
      sign_off_notes: notes || null,
      updated_at: new Date().toISOString(),
    } as any)
    .eq("id", flagId);
  if (error) throw new Error(error.message);

  // Unblock associated proposed entries
  await service
    .from("proposed_entries")
    .update({ period_impact: "current" } as any)
    .eq("cpa_flag_id", flagId)
    .eq("period_impact", "cpa_blocked");
}

export function requiresCpaFlag(
  txnDate: string,
  periodLockDate: string,
  impactType: "income" | "equity" | "tax"
): boolean {
  if (txnDate < periodLockDate) return true;
  return ["income", "equity", "tax"].includes(impactType);
}
