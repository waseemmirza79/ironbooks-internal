import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  scanUncatIncome,
  findUncategorizedIncomeAccount,
  inferCustomersWithClaude,
  applyAiInferences,
  fetchAllCustomers,
} from "@/lib/uncat-income-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/clients/[id]/uncat-income/scan
 *
 * 1. Pull Uncat Income deposits + JEs + open A/R invoices from QBO
 * 2. Deterministic match by amount + customer + date proximity
 * 3. Run Claude customer inference on no-match items (with safety rails)
 * 4. Persist items + scan row
 *
 * The Claude pass NEVER silently fails. The scan row tracks ai_status
 * explicitly so the UI can show a banner if AI assist didn't run.
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
    .select("id, qbo_realm_id, assigned_bookkeeper_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if ((client as any).is_active === false) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

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

  // Zombie cleanup + prior review cancellation
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await service
    .from("uncat_income_scans" as any)
    .update({
      status: "failed",
      error_message: "Scan did not complete (server timeout). Re-scan to retry.",
    } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "scanning")
    .lt("created_at", fiveMinAgo);
  await service
    .from("uncat_income_scans" as any)
    .update({ status: "cancelled" } as any)
    .eq("client_link_id", clientLinkId)
    .eq("status", "review");

  const { data: runIns, error: runErr } = await service
    .from("uncat_income_scans" as any)
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "scanning",
    } as any)
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create scan row: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const scanId = (runIns as any).id as string;
  const t0 = Date.now();

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const realmId = (client as any).qbo_realm_id;

    const uncatAccount = await findUncategorizedIncomeAccount(realmId, accessToken);
    if (!uncatAccount) {
      throw new Error(
        'No "Uncategorized Income" account found in QBO. If you renamed it, rename back temporarily or pick the account manually.'
      );
    }

    const scanResult = await scanUncatIncome(realmId, accessToken, uncatAccount);

    // ─── Claude inference pass (with safety rails) ───
    // Mark ai_status=running BEFORE the call so a hard process kill leaves a
    // visible trail. The 5-min zombie cleanup at the top of the next scan
    // will catch any stuck rows.
    await service
      .from("uncat_income_scans" as any)
      .update({
        ai_status: "running",
        ai_started_at: new Date().toISOString(),
      } as any)
      .eq("id", scanId);

    const customers = await fetchAllCustomers(realmId, accessToken);
    const inference = await inferCustomersWithClaude({
      items: scanResult.items,
      customers,
      openInvoices: scanResult.open_invoices,
    });

    const finalItems = applyAiInferences(
      scanResult.items,
      inference,
      scanResult.open_invoices
    );

    // Persist scan-level AI status
    await service
      .from("uncat_income_scans" as any)
      .update({
        ai_status: inference.status,
        ai_finished_at: new Date().toISOString(),
        ai_duration_ms: inference.durationMs,
        ai_items_considered: inference.itemsConsidered,
        ai_items_inferred: inference.itemsInferred,
        ai_error_message: inference.errorMessage,
      } as any)
      .eq("id", scanId);

    // Persist items
    if (finalItems.length > 0) {
      const itemRows = finalItems.map((p) => ({
        scan_id: scanId,
        client_link_id: clientLinkId,
        qbo_txn_id: p.qbo_txn_id,
        qbo_txn_type: p.qbo_txn_type,
        qbo_line_id: p.qbo_line_id,
        sync_token: p.sync_token,
        txn_date: p.txn_date,
        amount: p.amount,
        description: p.description,
        private_note: p.private_note,
        bank_account_id: p.bank_account_id,
        bank_account_name: p.bank_account_name,
        customer_qbo_id: p.customer_qbo_id,
        customer_name: p.customer_name,
        classification: p.classification,
        candidate_invoice_ids: p.candidates,
        ai_inferred_customer_id:
          p.classification === "ai_inferred" ? p.customer_qbo_id : null,
        ai_inferred_customer_name:
          p.classification === "ai_inferred" ? p.customer_name : null,
        ai_confidence: null, // populated below if available
        ai_reasoning: null,
        auto_approve_eligible: p.auto_approve_eligible,
        resolution: "pending",
      }));

      // Attach confidence + reasoning from inference map
      for (const row of itemRows) {
        const key = `${row.qbo_txn_id}|${row.qbo_line_id || ""}`;
        const inf = inference.inferred.get(key);
        if (inf) {
          (row as any).ai_confidence = inf.confidence;
          (row as any).ai_reasoning = inf.reasoning;
        }
      }

      const BATCH = 200;
      for (let i = 0; i < itemRows.length; i += BATCH) {
        const { error: itemErr } = await service
          .from("uncat_income_items" as any)
          .insert(itemRows.slice(i, i + BATCH) as any);
        if (itemErr) throw new Error(`Item insert failed: ${itemErr.message}`);
      }
    }

    await service
      .from("uncat_income_scans" as any)
      .update({
        status: "review",
        uncat_account_qbo_id: scanResult.uncat_account_qbo_id,
        uncat_account_name: scanResult.uncat_account_name,
        scan_from: scanResult.scan_from,
        scan_to: scanResult.scan_to,
        deposits_scanned: scanResult.deposits_scanned,
        open_invoices_scanned: scanResult.open_invoices_scanned,
        total_uncat_amount: scanResult.total_uncat_amount,
        exact_single_count: scanResult.exact_single_count,
        exact_multi_count: scanResult.exact_multi_count,
        no_match_count: scanResult.no_match_count,
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", scanId);

    return NextResponse.json({
      ok: true,
      scan_id: scanId,
      deposits_scanned: scanResult.deposits_scanned,
      open_invoices_scanned: scanResult.open_invoices_scanned,
      exact_single_count: scanResult.exact_single_count,
      exact_multi_count: scanResult.exact_multi_count,
      no_match_count: scanResult.no_match_count,
      total_uncat_amount: scanResult.total_uncat_amount,
      ai_status: inference.status,
      ai_items_inferred: inference.itemsInferred,
      ai_error_message: inference.errorMessage,
    });
  } catch (err: any) {
    await service
      .from("uncat_income_scans" as any)
      .update({
        status: "failed",
        error_message: err?.message || String(err),
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", scanId);
    return qboErrorResponse(err);
  }
}
