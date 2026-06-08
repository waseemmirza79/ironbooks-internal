import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, applyPaymentToInvoices, qboErrorResponse } from "@/lib/qbo";

/**
 * POST /api/balance-sheet/uf-ar/[id]/apply
 *
 * Push UF→A/R matches to QBO. Sparse-updates the UF Payment row in QBO,
 * linking it to the matched invoice(s) via LinkedTxn. The payment leaves
 * Undeposited Funds and the invoice balance drops accordingly — the exact
 * dance that drains the giant UF total and zeros the matching A/R.
 *
 * This is the endpoint that the /balance-sheet/uf-ar/[id]/review page
 * SHOULD have had since day one. Without it, the review screen was
 * display-only: bookkeepers worked through hundreds of matches and
 * accomplished nothing in QBO. Adding it closes the loop.
 *
 * Body:
 *   { match_ids: string[] }     # apply specific matches
 *   { kind: "exact" | "high" }  # apply all matches of one kind (bulk button)
 *
 * Returns per-match outcome so the UI can mark green/red row-by-row
 * rather than a single "all or nothing" status.
 */

export const runtime = "nodejs";
export const maxDuration = 300; // QBO calls are sequential and rate-limited

type ApplyOutcome = {
  match_id: string;
  status: "ok" | "skipped" | "failed";
  message: string;
  invoices_applied?: number;
  payment_id?: string;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const matchIdsInput: string[] = Array.isArray(body.match_ids) ? body.match_ids : [];
  const kindFilter: string | null =
    body.kind === "exact" ? "exact_invoice_number" :
    body.kind === "high"  ? "high_confidence"      :
    null;

  if (matchIdsInput.length === 0 && !kindFilter) {
    return NextResponse.json(
      { error: "match_ids or kind required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  // Load the job + client
  const { data: job, error: jobErr } = await (service as any)
    .from("uf_ar_jobs")
    .select("id, client_link_id, status")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", (job as any).client_link_id)
    .single();
  if (!clientLink) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  const realmId = (clientLink as any).qbo_realm_id as string;
  if (!realmId) {
    return NextResponse.json({ error: "Client has no qbo_realm_id" }, { status: 400 });
  }

  // Load the matches we'll apply. Two query shapes:
  //   - explicit ids (per-row Apply button)
  //   - by kind (bulk "Apply all exact matches" button)
  let matchQuery: any = (service as any)
    .from("uf_ar_matches")
    .select("*")
    .eq("job_id", jobId);
  if (matchIdsInput.length > 0) {
    matchQuery = matchQuery.in("id", matchIdsInput);
  } else if (kindFilter) {
    matchQuery = matchQuery.eq("match_kind", kindFilter);
  }
  const { data: matches, error: mErr } = await matchQuery;
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
  if (!matches || matches.length === 0) {
    return NextResponse.json({
      applied: 0,
      failed: 0,
      skipped: 0,
      outcomes: [],
      message: "No matches to apply for that selection.",
    });
  }

  // Get QBO token once. Friendly fail if expired — bookkeeper needs to
  // reconnect, doesn't need a stack trace.
  let accessToken: string;
  try {
    accessToken = await getValidToken(
      (clientLink as any).id,
      service as any,
      "ironbooks/api/balance-sheet/uf-ar/apply"
    );
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const outcomes: ApplyOutcome[] = [];
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const m of matches as any[]) {
    const matchId = m.id as string;
    const paymentId = m.qbo_payment_id as string | null;
    const amount = Number(m.uf_amount || 0);

    // Resolve which invoices to link: bookkeeper override wins, else the
    // proposed invoices from discovery. We only proceed when there's
    // exactly one resolved target (1:1 high-confidence path). Multi-invoice
    // allocations go through hardcore-cleanup's apply_payment flow.
    const overrideId: string | null = m.selected_invoice_id || null;
    const proposed: any[] = Array.isArray(m.proposed_invoices) ? m.proposed_invoices : [];

    let invoiceLinks: Array<{ invoiceId: string; amountApplied: number }> = [];
    if (overrideId) {
      invoiceLinks = [{ invoiceId: overrideId, amountApplied: amount }];
    } else if (proposed.length === 1) {
      // The matcher's proposal carries the invoice id; amount is the
      // full payment amount (these are 1:1 same-amount matches).
      invoiceLinks = [
        {
          invoiceId: String(proposed[0].qbo_invoice_id),
          amountApplied: amount,
        },
      ];
    }

    // Pre-flight checks — produce a clear `skipped` outcome instead of
    // throwing on rows that shouldn't have been in the apply batch.
    if (!paymentId) {
      outcomes.push({
        match_id: matchId,
        status: "skipped",
        message: "Match has no qbo_payment_id — can't apply.",
      });
      skipped++;
      continue;
    }
    if (invoiceLinks.length === 0) {
      outcomes.push({
        match_id: matchId,
        status: "skipped",
        message:
          "No target invoice selected — bookkeeper needs to pick one before this can apply.",
      });
      skipped++;
      continue;
    }
    if (amount <= 0) {
      outcomes.push({
        match_id: matchId,
        status: "skipped",
        message: `Payment amount is ${amount.toFixed(2)} — refusing to apply.`,
      });
      skipped++;
      continue;
    }

    // Skip if already executed (idempotency — re-clicking Apply on a
    // partially-finished batch shouldn't re-push). The decision string
    // lands at 'applied' after a successful push (set below).
    if (m.decision === "applied") {
      outcomes.push({
        match_id: matchId,
        status: "skipped",
        message: "Already applied to QBO.",
      });
      skipped++;
      continue;
    }

    try {
      const idempotencyToken = `SNAP-UFAR-${jobId}-${matchId}`;
      const applied_payment = await applyPaymentToInvoices(realmId, accessToken, {
        paymentId,
        invoiceLinks,
        privateNote: `Ironbooks UF→A/R match — ${idempotencyToken}`,
      });

      await (service as any)
        .from("uf_ar_matches")
        .update({
          decision: "applied",
          selected_invoice_id: invoiceLinks[0].invoiceId,
          applied_at: new Date().toISOString(),
          applied_by: user.id,
          qbo_response: applied_payment as any,
        })
        .eq("id", matchId);

      outcomes.push({
        match_id: matchId,
        status: "ok",
        message: `Applied $${amount.toFixed(2)} to invoice ${invoiceLinks[0].invoiceId}.`,
        invoices_applied: invoiceLinks.length,
        payment_id: paymentId,
      });
      applied++;
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Persist the error so the bookkeeper can re-open the page and see
      // exactly which rows failed and why.
      await (service as any)
        .from("uf_ar_matches")
        .update({
          decision: "apply_failed",
          apply_error: msg.slice(0, 1000),
          applied_at: null,
        })
        .eq("id", matchId);
      outcomes.push({
        match_id: matchId,
        status: "failed",
        message: msg,
      });
      failed++;
    }
  }

  // Update the job row summary so reopening the page reflects progress
  try {
    await (service as any)
      .from("uf_ar_jobs")
      .update({
        // Don't flip status to 'complete' here — bookkeeper may still
        // have unapplied / failed rows. Leave status alone; just bump
        // updated_at via a noop column write.
        last_applied_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } catch {
    // last_applied_at column may not exist yet on older schemas — non-fatal
  }

  return NextResponse.json({
    applied,
    failed,
    skipped,
    outcomes,
  });
}
