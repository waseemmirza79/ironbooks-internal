import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";

/**
 * POST /api/portal/transaction-flags
 *
 * Client submits a "this looks wrong" flag on a transaction from the P&L
 * drill-down drawer. Stores a snapshot of the transaction + the client's
 * free-text note. No QBO writes — bookkeeper triages.
 *
 * Body:
 *   {
 *     qbo_txn_id: string | null,
 *     qbo_txn_type: string | null,
 *     qbo_account_id: string,
 *     account_label: string,        // e.g. "Subcontractors"
 *     txn_date: string,             // YYYY-MM-DD
 *     txn_amount: number,
 *     txn_doc_number?: string,
 *     txn_vendor_or_customer?: string,
 *     txn_memo?: string,
 *     period_label: string,         // e.g. "Last month (April 2026)"
 *     period_start: string,         // YYYY-MM-DD
 *     period_end: string,           // YYYY-MM-DD
 *     client_note: string,          // required
 *   }
 *
 * Audit-logged. Skipped tally when impersonating (so admin testing
 * doesn't pollute the queue).
 */
export const dynamic = "force-dynamic";

const MAX_NOTE_LEN = 1500;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  // Block flagging while impersonating — clients shouldn't see test flags
  // from an admin's preview session.
  if (ctx.impersonating) {
    return NextResponse.json(
      {
        error:
          "You're viewing as an admin (impersonating). Flag submissions are disabled in this mode.",
        code: "impersonating",
      },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({} as any));
  const note = String(body.client_note || "").trim();
  if (!note) {
    return NextResponse.json({ error: "client_note is required" }, { status: 400 });
  }
  if (note.length > MAX_NOTE_LEN) {
    return NextResponse.json(
      { error: `Note is too long — keep it under ${MAX_NOTE_LEN} characters.` },
      { status: 400 }
    );
  }
  const accountId = String(body.qbo_account_id || "");
  if (!accountId) {
    return NextResponse.json({ error: "qbo_account_id is required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: inserted, error: insertErr } = await service
    .from("portal_transaction_flags" as any)
    .insert({
      client_link_id: ctx.clientLinkId,
      submitted_by: ctx.userId,
      qbo_txn_id: body.qbo_txn_id || null,
      qbo_txn_type: body.qbo_txn_type || null,
      qbo_account_id: accountId,
      account_label: body.account_label || null,
      txn_date: body.txn_date || null,
      txn_amount: body.txn_amount != null ? Number(body.txn_amount) : null,
      txn_doc_number: body.txn_doc_number || null,
      txn_vendor_or_customer: body.txn_vendor_or_customer || null,
      txn_memo: body.txn_memo || null,
      period_label: body.period_label || null,
      period_start: body.period_start || null,
      period_end: body.period_end || null,
      client_note: note,
      status: "pending",
    } as any)
    .select("id, submitted_at")
    .single();
  if (insertErr) {
    return NextResponse.json(
      { error: `Insert failed: ${insertErr.message}` },
      { status: 500 }
    );
  }

  await service.from("audit_log").insert({
    event_type: "portal_transaction_flagged",
    user_id: ctx.userId,
    request_payload: {
      client_link_id: ctx.clientLinkId,
      flag_id: (inserted as any).id,
      account_label: body.account_label,
      txn_amount: body.txn_amount,
      txn_vendor_or_customer: body.txn_vendor_or_customer,
    } as any,
  });

  return NextResponse.json({
    ok: true,
    flag_id: (inserted as any).id,
    submitted_at: (inserted as any).submitted_at,
  });
}

/**
 * GET /api/portal/transaction-flags
 *
 * Lists the client's OWN flag history (for the future "your flags" portal
 * view). Returns 50 most-recent. Internal staff get blocked here — they
 * use /api/today/transaction-flags instead.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const service = createServiceSupabase();
  const { data } = await service
    .from("portal_transaction_flags" as any)
    .select("*")
    .eq("client_link_id", ctx.clientLinkId)
    .order("submitted_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ ok: true, flags: data || [] });
}
