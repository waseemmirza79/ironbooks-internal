import { NextResponse } from "next/server";
import { runStripeConnectionReminder } from "@/lib/stripe-connection-reminder";
import { createServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET/POST /api/cron/stripe-connection-reminder
 *
 * Daily sweep that re-emails clients who were sent a Stripe connect request but
 * haven't connected (every ~3 days), and at 9 days escalates to a "call the
 * client" Today task. Same dual-auth as the other crons: Vercel Cron secret, or
 * a logged-in admin/lead hitting it manually.
 */
async function handleRequest(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["admin", "lead"].includes((profile as any).role)) {
      return NextResponse.json({ error: "Admin/lead only" }, { status: 403 });
    }
  }

  const result = await runStripeConnectionReminder();
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}
