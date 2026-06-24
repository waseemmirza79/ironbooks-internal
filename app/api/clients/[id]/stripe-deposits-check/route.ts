import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse, QBOReauthRequiredError } from "@/lib/qbo";
import { fetchStripeDeposits } from "@/lib/qbo-stripe-recon";

// Always live — must reflect the QBO state in real time.
export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/stripe-deposits-check?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Lightweight: hits QBO and counts Stripe-tagged deposits in a date
 * range. Used by the Bank Rules → Stripe Recon handoff so the
 * bookkeeper can skip the recon entirely when there are zero deposits
 * to reconcile in this cleanup's window — sparing them a useless trip
 * through the recon form just to be told "0 deposits found."
 *
 * Returns:
 *   { count: number, total_amount: number, sample: [{...}] (first 3) }
 *
 * Doesn't write to the DB. Idempotent. Cheap to call repeatedly.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end (YYYY-MM-DD) query params are required" },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, stripe_not_required")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Short-circuit: if the bookkeeper has flagged this client as not
  // using Stripe, we skip the QBO scan entirely and report 0 deposits.
  // The Bank Rules pre-check uses count==0 as the cue to render the
  // "skip Stripe recon" choice screen.
  if ((client as any).stripe_not_required) {
    return NextResponse.json({
      count: 0,
      total_amount: 0,
      stripe_not_required: true,
    });
  }

  let deposits;
  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    deposits = await fetchStripeDeposits(
      (client as any).qbo_realm_id,
      accessToken,
      start,
      end
    );
  } catch (err: any) {
    // Reauth required is NOT a soft failure — the user needs to know their
    // QBO connection is dead. Bypass the fail-open path and surface 401 so
    // the UI routes them to /api/qbo/connect.
    if (err instanceof QBOReauthRequiredError) return qboErrorResponse(err);
    // Fail-open: if we can't reach QBO, treat as "unknown" so the UI
    // falls back to the normal recon flow rather than silently skipping it.
    console.warn(`[stripe-deposits-check] QBO fetch failed for ${clientLinkId}:`, err?.message);
    return NextResponse.json({
      count: null,
      total_amount: null,
      error: "Could not query QBO for Stripe deposits — falling back to standard recon flow.",
    });
  }

  const total = deposits.reduce((s, d) => s + Number(d.amount || 0), 0);

  // Cache the result so the reminder cron + the form can read a shared signal
  // without re-hitting QBO. Best-effort — never blocks the response.
  service
    .from("client_links")
    .update({
      stripe_deposits_detected: deposits.length > 0,
      stripe_deposits_detected_at: new Date().toISOString(),
    } as any)
    .eq("id", clientLinkId)
    .then(undefined, (e: any) =>
      console.warn(`[stripe-deposits-check] could not cache result: ${e?.message}`)
    );

  return NextResponse.json({
    count: deposits.length,
    total_amount: total,
    sample: deposits.slice(0, 3).map((d) => ({
      date: d.date,
      amount: d.amount,
      memo: (d.memo || "").slice(0, 80),
    })),
  });
}
