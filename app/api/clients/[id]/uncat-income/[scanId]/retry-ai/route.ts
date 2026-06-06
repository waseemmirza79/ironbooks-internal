import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import {
  inferCustomersWithClaude,
  fetchAllCustomers,
  type ClassifiedItem,
} from "@/lib/uncat-income-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * POST /api/clients/[id]/uncat-income/[scanId]/retry-ai
 *
 * Re-runs the Claude customer-inference pass on items that didn't get
 * inferred the first time (or whenever the previous pass had ai_status
 * in: timeout, failed, partial, skipped). The route is the bookkeeper's
 * escape hatch — never auto-retries silently.
 *
 * Re-running on success status is allowed; new inferences merge into
 * existing ones.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id")
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

  const { data: scan } = await service
    .from("uncat_income_scans" as any)
    .select("*")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  if ((scan as any).status !== "review") {
    return NextResponse.json(
      { error: `Scan must be in 'review' state, currently '${(scan as any).status}'` },
      { status: 400 }
    );
  }

  // Only retry items that haven't already been resolved by the bookkeeper.
  const { data: itemsRaw } = await service
    .from("uncat_income_items" as any)
    .select("*")
    .eq("scan_id", scanId)
    .eq("resolution", "pending");
  const items = (itemsRaw as any[]) || [];
  if (items.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No pending items to retry.",
      ai_status: "skipped",
    });
  }

  await service
    .from("uncat_income_scans" as any)
    .update({
      ai_status: "running",
      ai_started_at: new Date().toISOString(),
      ai_error_message: null,
    } as any)
    .eq("id", scanId);

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const realmId = (client as any).qbo_realm_id;

    const [customers, openInvoices] = await Promise.all([
      fetchAllCustomers(realmId, accessToken),
      fetchOpenInvoices(realmId, accessToken),
    ]);

    // Reconstruct ClassifiedItem shape from DB rows for the inference helper
    const classified: ClassifiedItem[] = items.map((it) => ({
      qbo_txn_id: it.qbo_txn_id,
      qbo_txn_type: it.qbo_txn_type,
      qbo_line_id: it.qbo_line_id,
      sync_token: it.sync_token,
      txn_date: it.txn_date,
      amount: Number(it.amount),
      description: it.description || "",
      private_note: it.private_note || "",
      bank_account_id: it.bank_account_id,
      bank_account_name: it.bank_account_name,
      customer_qbo_id: it.customer_qbo_id,
      customer_name: it.customer_name,
      classification: it.classification,
      candidates: it.candidate_invoice_ids || [],
      auto_approve_eligible: it.auto_approve_eligible,
    }));

    const inference = await inferCustomersWithClaude({
      items: classified,
      customers,
      openInvoices,
    });

    // Apply inferences to DB
    let updated = 0;
    for (const item of items) {
      const key = `${item.qbo_txn_id}|${item.qbo_line_id || ""}`;
      const inf = inference.inferred.get(key);
      if (!inf) continue;

      // Find candidate invoices for this customer
      const customerInvoices = openInvoices
        .filter((inv) => inv.customer_id === inf.customer_qbo_id)
        .map((inv) => ({
          qbo_invoice_id: inv.qbo_invoice_id,
          doc_number: inv.doc_number,
          customer_qbo_id: inv.customer_id,
          customer_name: inv.customer_name,
          txn_date: inv.txn_date,
          balance: inv.balance,
        }))
        .slice(0, 10);

      await service
        .from("uncat_income_items" as any)
        .update({
          classification: "ai_inferred",
          customer_qbo_id: inf.customer_qbo_id,
          customer_name: inf.customer_name,
          ai_inferred_customer_id: inf.customer_qbo_id,
          ai_inferred_customer_name: inf.customer_name,
          ai_confidence: inf.confidence,
          ai_reasoning: inf.reasoning,
          candidate_invoice_ids: customerInvoices,
        } as any)
        .eq("id", item.id);
      updated++;
    }

    await service
      .from("uncat_income_scans" as any)
      .update({
        ai_status: inference.status,
        ai_finished_at: new Date().toISOString(),
        ai_duration_ms: inference.durationMs,
        ai_items_considered: inference.itemsConsidered,
        ai_items_inferred: updated,
        ai_error_message: inference.errorMessage,
      } as any)
      .eq("id", scanId);

    return NextResponse.json({
      ok: true,
      ai_status: inference.status,
      items_considered: inference.itemsConsidered,
      items_inferred: updated,
      duration_ms: inference.durationMs,
      error_message: inference.errorMessage,
    });
  } catch (err: any) {
    await service
      .from("uncat_income_scans" as any)
      .update({
        ai_status: "failed",
        ai_finished_at: new Date().toISOString(),
        ai_error_message: err?.message || String(err),
      } as any)
      .eq("id", scanId);
    return qboErrorResponse(err);
  }
}
