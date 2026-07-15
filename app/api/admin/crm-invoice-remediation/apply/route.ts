import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, voidInvoice, voidPayment } from "@/lib/qbo";
import { getCompanyClosingDate } from "@/lib/qbo-reclass";
import { buildRemediationPreview } from "../preview/route";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const BUDGET_MS = 240_000;
const MAX_PER_PASS = 40;

/**
 * POST /api/admin/crm-invoice-remediation/apply   (WRITES TO QBO)
 *   { client_link_id, start?, end?, invoice_ids: string[],
 *     dry_run?: boolean (default TRUE), allow_review?: boolean (default false) }
 *
 * For each selected recognized CRM invoice: VOID its phantom UF payment(s),
 * then VOID the invoice (keeps the doc, zeroes the income). The real bank
 * deposit is never touched. This is the "recognize deposits only, remove the
 * duplicate invoices" fix, executed on the ledger.
 *
 * Hard guards — every one re-checked server-side, client input never trusted:
 *   1. Admin/lead only.
 *   2. dry_run defaults TRUE — you must pass dry_run:false to write.
 *   3. Re-plans live from QBO (buildRemediationPreview); only invoices that are
 *      STILL `safe` are touched. A "review" invoice (real cash on a payment) is
 *      skipped unless allow_review:true is passed explicitly.
 *   4. Closed periods skipped (invoice dated on/before the QBO close date).
 *   5. Budget-chunked: returns remaining_ids; the UI re-invokes until done.
 * Idempotent-ish: an already-voided invoice/payment just reports as skipped.
 */
export async function POST(request: Request) {
  const startTime = Date.now();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  const ids: string[] = Array.isArray(body.invoice_ids) ? body.invoice_ids.map(String) : [];
  const dryRun = body.dry_run !== false; // default TRUE — must opt in to write
  const allowReview = body.allow_review === true;
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(body.start || "") ? body.start : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(body.end || "") ? body.end : new Date().toISOString().slice(0, 10);

  if (!clientLinkId || ids.length === 0) {
    return NextResponse.json({ error: "client_link_id and invoice_ids required" }, { status: 400 });
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, qbo_realm_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client?.qbo_realm_id || !client.is_active) {
    return NextResponse.json({ error: "Client inactive or no QBO connection" }, { status: 400 });
  }
  const realm = (client as any).qbo_realm_id as string;

  let token: string;
  try {
    token = await getValidToken(clientLinkId, service as any);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "QBO auth failed" }, { status: 502 });
  }

  // Re-plan live from QBO — never trust the client's safety flags.
  const planned = await buildRemediationPreview(realm, token, start, end).catch((e) => {
    throw new Error(`Re-plan failed: ${e?.message || e}`);
  });
  const planById = new Map(planned.map((p) => [p.invoiceId, p]));
  const closingDate = await getCompanyClosingDate(realm, token).catch(() => null);

  const selected = ids.filter((id) => planById.has(id));
  const summary = {
    dry_run: dryRun,
    requested: ids.length,
    would_void_invoices: 0,
    would_void_payments: 0,
    voided_invoices: 0,
    voided_payments: 0,
    skipped_closed: 0,
    skipped_review: 0,
    skipped_not_candidate: ids.length - selected.length,
    failed: 0,
    remaining_ids: [] as string[],
    details: [] as Array<{ invoiceId: string; doc: string | null; outcome: string; amount: number }>,
  };

  const memo = `SNAP CRM revenue remediation by ${(actor as any)?.full_name || "senior"} — voided duplicate CRM invoice (recognize deposits only)`;

  for (let i = 0; i < selected.length; i++) {
    if (Date.now() - startTime > BUDGET_MS || i >= MAX_PER_PASS) {
      summary.remaining_ids.push(...selected.slice(i));
      break;
    }
    const id = selected[i];
    const plan = planById.get(id)!;

    if (!plan.safe && !allowReview) {
      summary.skipped_review++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "skipped: review (real cash on a payment)", amount: plan.total });
      continue;
    }
    if (closingDate && plan.date && plan.date <= closingDate) {
      summary.skipped_closed++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: `skipped: closed period (${closingDate})`, amount: plan.total });
      continue;
    }

    if (dryRun) {
      summary.would_void_invoices++;
      summary.would_void_payments += plan.payments.length;
      summary.details.push({
        invoiceId: id,
        doc: plan.docNumber,
        outcome: plan.action === "void_invoice_only"
          ? "would void invoice (no payment)"
          : `would void ${plan.payments.length} payment(s) + invoice`,
        amount: plan.total,
      });
      continue;
    }

    // ── WRITE ── void payment(s) first (unlinks), then the invoice.
    try {
      for (const p of plan.payments) {
        await voidPayment(realm, token, p.id, "Payment");
        summary.voided_payments++;
      }
      await voidInvoice(realm, token, id);
      summary.voided_invoices++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: "voided invoice + payment(s)", amount: plan.total });
    } catch (err: any) {
      summary.failed++;
      summary.details.push({ invoiceId: id, doc: plan.docNumber, outcome: `FAILED: ${String(err?.message || err).slice(0, 160)}`, amount: plan.total });
    }
  }

  if (!dryRun) {
    try {
      await service.from("audit_log").insert({
        event_type: "crm_invoice_remediation_apply",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLinkId,
          client_name: (client as any).client_name,
          window: { start, end },
          memo,
          ...summary,
          details: summary.details.slice(0, 60),
          remaining: summary.remaining_ids.length,
          remaining_ids: undefined,
        } as any,
      } as any);
    } catch (e: any) {
      console.warn(`[crm-invoice-remediation] audit insert failed: ${e?.message}`);
    }
  }

  return NextResponse.json(summary);
}
