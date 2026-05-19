import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/stripe-recon/active?client_link_id=...
 *
 * Returns the in-flight Stripe reconciliation job for a client, if any.
 * Used by the new-recon form to pre-check before the bookkeeper hits
 * submit, so the existing same-client concurrency 409 doesn't show up
 * in the console as a phantom "Failed to load resource" error. The
 * server-side guard in /api/stripe-recon/discover still stands as the
 * source of truth — this endpoint is purely a UX nicety.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const clientLinkId = url.searchParams.get("client_link_id");
  if (!clientLinkId) {
    return NextResponse.json({ active: null }); // empty query = no client picked yet
  }

  // Same status set the server-side concurrency guard uses. Keep these
  // in sync with /api/stripe-recon/discover/route.ts ACTIVE_STRIPE_RECON_STATUSES.
  const ACTIVE = ["discovering", "in_review", "executing"];

  const service = createServiceSupabase();
  const { data } = await service
    .from("stripe_recon_jobs")
    .select("id, status, created_at")
    .eq("client_link_id", clientLinkId)
    .in("status", ACTIVE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    active: data
      ? { id: (data as any).id, status: (data as any).status, created_at: (data as any).created_at }
      : null,
  });
}
