import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/bs-ai-fix/[runId]
 *
 * Returns a single AI cleanup run + all its issues. Drives the review
 * page; cached server-side so reloading is free.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: clientLinkId, runId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: run } = await service
    .from("bs_ai_fix_runs" as any)
    .select("*")
    .eq("id", runId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: items } = await service
    .from("bs_ai_fix_items" as any)
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    ok: true,
    run,
    items: items || [],
  });
}
