import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

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

  // Include every decision type that came in with a vendor + target. The
  // page surfaces them all; the POST has to accept them all too, otherwise
  // selected vendors silently drop out at create time.
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount"
    )
    .eq("reclass_job_id", reclass_job_id)
    .in("decision", ["auto_approve", "approved", "needs_review", "flagged", "ask_client"])
    .not("vendor_name", "is", null);

  type ReclassRow = {
    vendor_name: string | null;
    vendor_pattern_normalized: string | null;
    to_account_id: string;
    to_account_name: string | null;
    bookkeeper_override_target_id: string | null;
    bookkeeper_override_target_name: string | null;
    transaction_amount: number | null;
  };

  const groupMap = new Map<
    string,
    {
      vendorDisplay: string;
      targetCounts: Map<string, { id: string; name: string; count: number }>;
      txCount: number;
      totalAmount: number;
      sampleDescriptions: string[];
    }
  >();

  // "Unknown vendor" is QBO's own literal fallback label for e-transfers/ACH
  // with no identifiable payee (lib/qbo-reclass.ts) — it has no real pattern
  // to key a bank rule on and can never match actual bank-feed text. This
  // route has no description fallback (that's the bank-rules review page's
  // job); just skip it rather than create an unmatchable rule.
  const UNKNOWN_VENDOR_KEYS = new Set(["unknown vendor", "unknown", ""]);
  // "Uncategorized" is the reclass-review dropdown's "flag for senior
  // review" sentinel, not a real QBO account — never a valid rule target.
  function isRealTarget(name: string | null | undefined): name is string {
    if (!name) return false;
    const norm = name.trim().toLowerCase();
    return norm !== "" && norm !== "uncategorized";
  }

  for (const row of (rows || []) as ReclassRow[]) {
    const groupKey = row.vendor_pattern_normalized || row.vendor_name || "";
    if (!groupKey) continue;
    if (UNKNOWN_VENDOR_KEYS.has(groupKey.trim().toLowerCase())) continue;

    const targetId = row.bookkeeper_override_target_id || row.to_account_id;
    const targetName = row.bookkeeper_override_target_name || row.to_account_name;
    if (!isRealTarget(targetName)) continue;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        vendorDisplay: row.vendor_name || groupKey,
        targetCounts: new Map(),
        txCount: 0,
        totalAmount: 0,
        sampleDescriptions: [],
      });
    }

    const group = groupMap.get(groupKey)!;
    group.txCount += 1;
    group.totalAmount += row.transaction_amount || 0;

    if (row.vendor_name && group.sampleDescriptions.length < 3) {
      if (!group.sampleDescriptions.includes(row.vendor_name)) {
        group.sampleDescriptions.push(row.vendor_name);
      }
    }

    const existing = group.targetCounts.get(targetId);
    if (existing) {
      existing.count += 1;
    } else {
      group.targetCounts.set(targetId, { id: targetId, name: targetName, count: 1 });
    }
  }

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

  for (const [vendorPattern, group] of groupMap.entries()) {
    if (!selectedSet.has(vendorPattern)) continue;

    // Prefer the bookkeeper's override (set in the dropdown); fall back to
    // the most-frequent AI-picked target.
    let bestTarget = { id: "", name: "" };
    const override = overrides?.[vendorPattern];
    if (override?.name) {
      bestTarget = { id: override.id || "", name: override.name };
    } else {
      let bestCount = 0;
      for (const t of group.targetCounts.values()) {
        if (t.count > bestCount) {
          bestCount = t.count;
          bestTarget = { id: t.id, name: t.name };
        }
      }
    }
    if (!bestTarget.name) continue;

    rulesToUpsert.push({
      client_link_id,
      vendor_pattern: vendorPattern,
      match_type: "CONTAINS",
      target_account_name: bestTarget.name,
      status: "approved",
      ai_confidence: null,
      ai_reasoning: null,
      requires_approval: false,
      sample_descriptions: group.sampleDescriptions,
      transaction_count: group.txCount,
      total_amount: group.totalAmount,
      created_by: user.id, // UUID — bank_rules.created_by FKs to users.id
    });
  }

  if (rulesToUpsert.length === 0) {
    return NextResponse.json({ created: 0, rules: [] });
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

  return NextResponse.json({
    created: upsertedRows.length,
    rules: upsertedRows,
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
