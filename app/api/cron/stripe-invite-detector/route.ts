import { NextResponse } from "next/server";
import { runStripeInviteDetector } from "@/lib/stripe-invite-detector";
import { createServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// QBO sweeps can take a while across many clients; cron jobs on Vercel
// Pro allow up to 5 min execution, hobby is 60s. We're well under either.
export const maxDuration = 300;

/**
 * GET /api/cron/stripe-invite-detector
 *
 * Scans every QBO-connected, Stripe-NOT-connected client for
 * Stripe-tagged deposits in the last 3 months and writes findings to
 * client_links so the dashboard widget can surface them.
 *
 * Vercel Cron hits this daily. Two auth paths:
 *
 *  1. Vercel Cron: includes an Authorization: Bearer <CRON_SECRET>
 *     header that matches our env var. No user session required.
 *  2. Manual trigger by an admin/lead browsing the URL while logged in.
 *     We check role and allow it.
 *
 * POST does the same thing (for fetch() from the admin UI).
 */
async function handleRequest(request: Request) {
  // Auth check #1: Vercel Cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const isCron =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    // Auth check #2: human admin/lead
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "lead"].includes((profile as any).role)) {
      return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
    }
  }

  const result = await runStripeInviteDetector();
  return NextResponse.json({
    ok: true,
    ...result,
  });
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}
