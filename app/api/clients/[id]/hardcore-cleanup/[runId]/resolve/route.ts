import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/hardcore-cleanup/[runId]/resolve
 *
 * Bulk-set resolution on a list of items. Used by single-row picker and
 * "accept all duplicates" bulk action.
 *
 * Body: {
 *   item_ids: string[],
 *   resolution: "pending"|"je_writeoff"|"direct_void"|"keep"|"manual"|"push_invoice"|"apply_payment",
 *   resolution_target_account_id?: string,
 *   resolution_target_account_name?: string,
 *   resolution_notes?: string,
 *   resolution_je_date?: string,    // YYYY-MM-DD — TxnDate the QBO
 *                                    // posting uses. Null = today's date.
 * }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: clientLinkId, runId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
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

  const body = await request.json().catch(() => ({} as any));
  const itemIds: string[] = Array.isArray(body.item_ids) ? body.item_ids : [];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "item_ids required" }, { status: 400 });
  }
  // Full set finalize knows how to execute. `push_invoice` (create new
  // QBO invoice from CRM job data) and `apply_payment` (sparse-update UF
  // payment with LinkedTxn) were missing here even though finalize
  // already handled them — Cody Ruane / Clean Cut Painters caught this
  // when bookkeeper had nothing valid to pick for missing_invoice items.
  const allowed = new Set([
    "pending", "je_writeoff", "direct_void", "keep", "manual",
    "push_invoice", "apply_payment",
    // v6 — uncat_income items: bookkeeper picks a target revenue account
    // and finalize sparse-updates the Deposit/JE Line.AccountRef in QBO.
    "recategorize",
  ]);
  if (!allowed.has(body.resolution)) {
    return NextResponse.json({ error: `Invalid resolution: ${body.resolution}` }, { status: 400 });
  }
  // je_writeoff requires a target account
  if (body.resolution === "je_writeoff" && !body.resolution_target_account_id) {
    return NextResponse.json(
      { error: "je_writeoff requires resolution_target_account_id (Bad Debt / similar)" },
      { status: 400 }
    );
  }
  // recategorize also requires a target account — that's the whole point.
  // Finalize sparse-updates the Deposit/JE Line's AccountRef to this id.
  if (body.resolution === "recategorize" && !body.resolution_target_account_id) {
    return NextResponse.json(
      { error: "recategorize requires resolution_target_account_id (the target revenue account)" },
      { status: 400 }
    );
  }
  // Defensive: cross-check resolution against the items' shape so the
  // resolution can never be set in a way finalize will reject.
  //
  // direct_void ALWAYS needs an invoice to act on — QBO's Invoice.void
  // endpoint requires the Id. No way around it.
  //
  // je_writeoff USED to require an invoice too, but Mike's new "Bulk JE
  // → write off revenue OR bad debt" button on missing_invoice items
  // legitimately needs to book a JE without a referenced invoice (e.g.
  // a job was completed but the invoice never got created in QBO — the
  // bookkeeper still wants to recognize/write-off the revenue via a JE
  // posting directly to A/R + a target account). Finalize builds the
  // JE differently for that case (Dr target, Cr A/R with Customer
  // Entity — no invoice DocNumber reference).
  if (body.resolution === "direct_void") {
    const { data: badItems } = await service
      .from("hardcore_cleanup_items" as any)
      .select("id, item_type, qbo_invoice_id")
      .in("id", itemIds)
      .or("qbo_invoice_id.is.null,qbo_invoice_id.eq.")
      .limit(5);
    if (badItems && (badItems as any[]).length > 0) {
      const names = (badItems as any[])
        .map((i) => i.item_type)
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .join(", ");
      return NextResponse.json(
        {
          error: `Can't pick "direct_void" for items of type "${names}" — direct_void requires a QBO invoice to void. Use "push_invoice", "je_writeoff", "keep", or "manual" for those.`,
        },
        { status: 400 }
      );
    }
  }

  // je_writeoff defense: only items that have NEITHER a qbo_invoice_id
  // NOR a customer name are unrecoverable — there's nothing for finalize
  // to attach the credit side of the JE to. Block those.
  if (body.resolution === "je_writeoff") {
    const { data: badItems } = await service
      .from("hardcore_cleanup_items" as any)
      .select("id, item_type, qbo_invoice_id, qbo_customer_name, uf_customer_name")
      .in("id", itemIds)
      .or("qbo_invoice_id.is.null,qbo_invoice_id.eq.")
      .limit(50);
    const unrecoverable = ((badItems as any[]) || []).filter(
      (i) => !i.qbo_customer_name && !i.uf_customer_name
    );
    if (unrecoverable.length > 0) {
      return NextResponse.json(
        {
          error: `Can't pick "je_writeoff" for ${unrecoverable.length} item${unrecoverable.length === 1 ? "" : "s"} that have no QBO invoice AND no customer name — finalize has nothing to credit. Mark these as "keep" or "manual" instead.`,
        },
        { status: 400 }
      );
    }
  }

  // Optional posting-date override. Validate YYYY-MM-DD shape so a typo
  // in the UI can't corrupt the column.
  let resolutionJeDate: string | null = null;
  if (body.resolution_je_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.resolution_je_date)) {
      return NextResponse.json(
        { error: "resolution_je_date must be YYYY-MM-DD" },
        { status: 400 }
      );
    }
    resolutionJeDate = body.resolution_je_date;
  }

  const updates: any = {
    resolution: body.resolution,
    resolution_target_account_id: body.resolution_target_account_id || null,
    resolution_target_account_name: body.resolution_target_account_name || null,
    resolution_notes: body.resolution_notes || null,
    resolution_je_date: resolutionJeDate,
    resolved_by: body.resolution === "pending" ? null : user.id,
    resolved_at: body.resolution === "pending" ? null : new Date().toISOString(),
  };

  const { error: updErr, count } = await service
    .from("hardcore_cleanup_items" as any)
    .update(updates as any, { count: "exact" })
    .eq("run_id", runId)
    .in("id", itemIds);

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Refresh aggregate count on the run
  const { count: resolvedCount } = await service
    .from("hardcore_cleanup_items" as any)
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .neq("resolution", "pending");
  await service
    .from("hardcore_cleanup_runs" as any)
    .update({ duplicates_resolved: resolvedCount || 0 } as any)
    .eq("id", runId);

  return NextResponse.json({ ok: true, updated: count || 0 });
}
