import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildRuleCandidates, type RuleSourceRow } from "@/lib/rules-eligibility";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { reclass_job_id, client_link_id, selected_vendors, overrides } = body as {
    reclass_job_id: string;
    client_link_id: string;
    selected_vendors: string[];
    overrides?: Record<string, { id: string; name: string }>;
  };

  if (!reclass_job_id || !client_link_id || !selected_vendors?.length) {
    return NextResponse.json(
      { error: "reclass_job_id, client_link_id, and selected_vendors are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // SHARED grouping + eligibility (lib/rules-eligibility.ts, D14): the exact
  // same function the candidates page uses, so what the page shows is what
  // this route creates — no filter drift, ever. Pull ALL rows (decision
  // filtering lives inside the shared predicate; unknown-vendor rows group by
  // bank description exactly like the page).
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, description, decision, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount"
    )
    .eq("reclass_job_id", reclass_job_id);

  const { candidates } = buildRuleCandidates((rows || []) as RuleSourceRow[]);
  const candidateByKey = new Map(candidates.map((c) => [c.vendorPattern, c]));

  // Existing rules for created-vs-updated classification in the response.
  const { data: existingPatterns } = await service
    .from("bank_rules")
    .select("vendor_pattern")
    .eq("client_link_id", client_link_id);
  const existedBefore = new Set(
    ((existingPatterns || []) as Array<{ vendor_pattern: string | null }>)
      .map((r) => r.vendor_pattern)
      .filter(Boolean) as string[]
  );

  const skipped: Array<{ vendorPattern: string; reason: string }> = [];
  const selectedSet = new Set(selected_vendors);
  // NOTE: `pushed_to_qbo` deliberately excluded — Supabase upsert generates
  // `ON CONFLICT DO UPDATE SET col=excluded.col` for every column in the
  // payload. Including pushed_to_qbo:false would clobber the flag on
  // already-exported rules and re-include them in the next .xls export,
  // creating duplicate rules in QBO on import. New rows get the column
  // default (false); existing rows keep whatever they had.
  const rulesToUpsert: Array<{
    client_link_id: string;
    vendor_pattern: string;
    match_type: string;
    target_account_name: string;
    status: string;
    ai_confidence: null;
    ai_reasoning: null;
    requires_approval: boolean;
    sample_descriptions: string[];
    transaction_count: number;
    total_amount: number;
    created_by: string;
  }> = [];

  for (const vendorPattern of selectedSet) {
    const candidate = candidateByKey.get(vendorPattern);
    if (!candidate) {
      // Selected on the page but no eligible rows server-side — with the
      // shared predicate this only happens on a stale page (rows changed
      // since load). Named, never silent.
      skipped.push({ vendorPattern, reason: "no eligible transactions (rejected/no-vendor rows can't become rules)" });
      continue;
    }

    // Prefer the bookkeeper's override (set in the dropdown); fall back to
    // the most-frequent observed real target.
    const override = overrides?.[vendorPattern];
    const bestTarget = override?.name
      ? { id: override.id || "", name: override.name }
      : { id: candidate.targetAccountId, name: candidate.targetAccountName };
    if (!bestTarget.name) {
      skipped.push({ vendorPattern, reason: "no target account picked" });
      continue;
    }

    rulesToUpsert.push({
      client_link_id,
      vendor_pattern: vendorPattern,
      match_type: "CONTAINS",
      target_account_name: bestTarget.name,
      status: "approved",
      ai_confidence: null,
      ai_reasoning: null,
      requires_approval: false,
      sample_descriptions: candidate.sampleDescriptions,
      transaction_count: candidate.txCount,
      total_amount: candidate.totalAmount,
      created_by: user.id, // UUID — bank_rules.created_by FKs to users.id
    });
  }

  if (rulesToUpsert.length === 0) {
    return NextResponse.json({ created: 0, rules: [], created_new: [], updated_existing: [], skipped, coverage: 0 });
  }

  const { data: upserted, error } = await service
    .from("bank_rules")
    .upsert(rulesToUpsert, { onConflict: "client_link_id,vendor_pattern" })
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ──────────────────── ACTIVATE LOCALLY ────────────────────
  // We used to try to push these rules to QBO via /bankrule, but Intuit's
  // public API does NOT support creating bank rules (every POST returns
  // "Operation bankrule is not supported"). Instead, rules go ACTIVE in
  // SNAP's daily-recon engine, which applies them to new transactions and
  // posts the reclass to QBO via the supported endpoint.
  //
  // End result for the bookkeeper is the same — categorized transactions
  // in QBO — just a different mechanism. See /api/rules/execute for the
  // other half of this fix.
  const upsertedRows = (upserted || []) as Array<{
    id: string;
    vendor_pattern: string;
    match_type: string | null;
    target_account_name: string;
    pushed_to_qbo: boolean | null;
    qbo_rule_id: string | null;
    tax_code_ref: string | null;
  }>;

  // Mark every just-upserted "approved" row as active in our engine.
  const idsToActivate = upsertedRows.map((r) => r.id);
  if (idsToActivate.length > 0) {
    await service
      .from("bank_rules")
      .update({ status: "active", pushed_to_qbo: false } as any)
      .in("id", idsToActivate);
  }

  await service.from("audit_log").insert({
    event_type: "bank_rules_activated",
    user_id: user.id,
    request_payload: {
      reclass_job_id,
      client_link_id,
      rules_activated: idsToActivate.length,
      vendor_patterns: upsertedRows.map((r) => r.vendor_pattern),
      source: "from_reclass",
    } as any,
  });

  // Transparency (D14): split brand-new rules from refreshed existing ones,
  // attach per-rule coverage ("covers N transactions from this job"), and
  // name every skipped selection with its reason — no silent drops.
  const describe = (r: (typeof upsertedRows)[number]) => {
    const c = candidateByKey.get(r.vendor_pattern);
    return {
      vendorPattern: r.vendor_pattern,
      targetAccountName: r.target_account_name,
      coversTransactions: c?.txCount ?? 0,
    };
  };
  const createdNew = upsertedRows.filter((r) => !existedBefore.has(r.vendor_pattern)).map(describe);
  const updatedExisting = upsertedRows.filter((r) => existedBefore.has(r.vendor_pattern)).map(describe);
  const coverage = [...createdNew, ...updatedExisting].reduce((s, r) => s + r.coversTransactions, 0);

  return NextResponse.json({
    created: upsertedRows.length,
    rules: upsertedRows,
    created_new: createdNew,
    updated_existing: updatedExisting,
    skipped,
    coverage,
    pushed: idsToActivate.length,    // legacy key kept for UI compat
    activated: idsToActivate.length,
    push_failed: 0,
    push_errors: [],
    message:
      `${idsToActivate.length} rule${idsToActivate.length === 1 ? "" : "s"} activated in SNAP's daily-recon engine. ` +
      `New transactions matching these patterns will categorize automatically when they sync. ` +
      `(QBO's public API doesn't support creating native bank rules — this is the supported alternative.)`,
  });
}

// QBO writes are sequential with rate-limit waits; budget for moderately
// large rule sets (50+ vendors) without hitting Vercel's default cap.
export const maxDuration = 300;
