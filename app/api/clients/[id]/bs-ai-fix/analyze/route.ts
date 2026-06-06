import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { analyzeBs, shouldPreAccept } from "@/lib/bs-ai-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/clients/[id]/bs-ai-fix/analyze
 *
 * Snapshot the client's BS, run Claude analysis, persist the run +
 * structured issues in bs_ai_fix_runs / bs_ai_fix_items. Returns the
 * new run_id so the review UI can route to it.
 *
 * Owner bookkeeper or admin/lead only. Expensive (Claude Opus call) — no
 * rate-limiting in v1, but the review screen caches the run_id so reloads
 * don't re-analyze.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, qbo_realm_id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const c = client as any;

  // Defensive: kill any zombie "analyzing" run >5 min old before starting
  // a new one. A function crash mid-Claude-call would otherwise leave the
  // run stuck in 'analyzing' forever, blocking the UI's analyze CTA.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await service
    .from("bs_ai_fix_runs" as any)
    .update({
      status: "failed",
      error_message:
        "Analysis did not complete (server timeout or crash). Re-analyze to retry.",
    } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "analyzing")
    .lt("created_at", fiveMinAgo);

  // Cancel any prior 'review' runs for this client — re-analyzing means
  // the bookkeeper is abandoning whatever decisions they made there.
  // Keeps the latest-run query unambiguous and prevents stale items from
  // accumulating across multiple runs.
  await service
    .from("bs_ai_fix_runs" as any)
    .update({ status: "cancelled" } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "review");

  // Create the run row up-front so we have an ID to attach items + status
  const { data: runIns, error: runErr } = await service
    .from("bs_ai_fix_runs" as any)
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "analyzing",
    } as any)
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create run row: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const runId = (runIns as any).id as string;

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const { result, snapshot, durationMs } = await analyzeBs({
      clientName: c.client_name,
      jurisdiction: c.jurisdiction,
      stateProvince: c.state_province || "",
      realmId: c.qbo_realm_id,
      accessToken,
    });

    // Pre-accept policy: conservative — confidence ≥ 0.95, low risk,
    // non-tax-sensitive, not a JE proposal.
    const itemRows = result.issues.map((iss) => ({
      run_id: runId,
      client_link_id: clientLinkId,
      kind: iss.kind,
      account_qbo_id: iss.account_qbo_id,
      account_name: iss.account_name,
      description: iss.description,
      ai_reasoning: iss.ai_reasoning,
      proposed_fix: iss.proposed_fix,
      confidence: iss.confidence,
      risk: iss.risk,
      estimated_impact: iss.estimated_impact,
      decision: shouldPreAccept(iss) ? "accepted" : "pending",
      decided_by: shouldPreAccept(iss) ? user.id : null,
      decided_at: shouldPreAccept(iss) ? new Date().toISOString() : null,
    }));

    if (itemRows.length > 0) {
      const { error: itemErr } = await service
        .from("bs_ai_fix_items" as any)
        .insert(itemRows as any);
      if (itemErr) throw new Error(`Failed to insert items: ${itemErr.message}`);
    }

    const acceptedCount = itemRows.filter((r) => r.decision === "accepted").length;
    const totalImpact = result.issues.reduce((s, i) => s + i.estimated_impact, 0);

    await service
      .from("bs_ai_fix_runs" as any)
      .update({
        status: "review",
        issues_count: result.issues.length,
        accepted_count: acceptedCount,
        rejected_count: 0,
        modified_count: 0,
        total_estimated_impact: totalImpact,
        snapshot_summary: {
          bs_accounts_total: snapshot.bs_accounts.length,
          suspect_accounts: Object.keys(snapshot.suspect_transactions).length,
          suspect_lines: Object.values(snapshot.suspect_transactions).reduce(
            (s, arr) => s + arr.length,
            0
          ),
          has_retained_earnings: !!snapshot.retained_earnings_account,
          has_bad_debt: !!snapshot.bad_debt_account,
        },
        ai_summary: result.summary,
        ai_warnings: result.warnings,
        duration_ms: durationMs,
      } as any)
      .eq("id", runId);

    return NextResponse.json({
      ok: true,
      run_id: runId,
      issues_count: result.issues.length,
      auto_accepted: acceptedCount,
    });
  } catch (err: any) {
    await service
      .from("bs_ai_fix_runs" as any)
      .update({
        status: "failed",
        error_message: err?.message || String(err),
      } as any)
      .eq("id", runId);
    return qboErrorResponse(err);
  }
}
