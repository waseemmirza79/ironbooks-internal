import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { runDailyRecon } from "@/lib/daily-recon";

export const dynamic = "force-dynamic";
export const maxDuration = 800; // big tick — many clients × per-client pipeline

/**
 * GET/POST /api/cron/daily-recon
 *
 * SCAFFOLDED. NOT registered in vercel.json — this endpoint exists but
 * will only fire when manually invoked (or once added to the crons array).
 *
 * Iterates every client where daily_recon_enabled=true, runs the
 * reconciliation pipeline, and returns a summary.
 *
 * Auth (matches the pattern from stripe-invite-detector):
 *   1. Cron secret header: `Authorization: Bearer ${CRON_SECRET}` — for Vercel Cron
 *   2. Admin/lead session — for manual runs from the admin panel
 *
 * Query/body params:
 *   - dryRun=true|false (default: true — safety while wiring)
 *
 * When ready to go live, add to vercel.json:
 *   {
 *     "path": "/api/cron/daily-recon",
 *     "schedule": "0 13,17,21 * * *"   // 3× daily (UTC)
 *   }
 */
async function handleRequest(request: Request) {
  // ── AUTH ──
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization") || "";
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCron) {
    const supabase = await createServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const service = createServiceSupabase();
    const { data: actor } = await service
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!["admin", "lead"].includes((actor as any)?.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // ── PARAMS ──
  const url = new URL(request.url);
  const dryRunParam = url.searchParams.get("dryRun");
  // Default: dry-run TRUE. Flip to false in vercel.json by passing ?dryRun=false
  // on the cron's path when we go live.
  const dryRun = dryRunParam === null ? true : dryRunParam !== "false";

  const service = createServiceSupabase();

  // ── PICK CLIENTS ──
  const { data: clients, error } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .eq("daily_recon_enabled" as any, true)
    .eq("daily_recon_paused" as any, false);

  if (error) {
    return NextResponse.json({ error: `client_links query: ${error.message}` }, { status: 500 });
  }

  const eligible = (clients || []) as Array<{ id: string; client_name: string }>;

  // ── RUN WITH BOUNDED CONCURRENCY ──
  // Process up to CONCURRENCY clients in parallel to scale to ~1000 clients
  // without exceeding Vercel timeout. QBO rate limits handled per-realm.
  const CONCURRENCY = 5;
  const results: any[] = [];

  async function runOne(c: { id: string; client_name: string }) {
    const t0 = Date.now();
    const res = await runDailyRecon(c.id, { dryRun });
    return {
      client_link_id: c.id,
      client_name: c.client_name,
      status: res.status,
      transactions_pulled: res.transactions_pulled,
      auto_executed: res.auto_executed,
      queued_for_review: res.queued_for_review,
      anomalies: res.anomalies_count,
      duration_ms: Date.now() - t0,
      error: res.error,
    };
  }

  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(runOne));
    results.push(...batchResults);
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    eligible_clients: eligible.length,
    ran_at: new Date().toISOString(),
    results,
  });
}

export async function GET(request: Request) {
  return handleRequest(request);
}
export async function POST(request: Request) {
  return handleRequest(request);
}
