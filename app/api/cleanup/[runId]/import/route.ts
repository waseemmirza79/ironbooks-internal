import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { parseCsvToCanonical, importRecords } from "@/lib/cleanup-system/csv-adapters";
import type { ImportSource } from "@/lib/cleanup-system/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup/[runId]/import
 * Body: { source: "stripe"|"bank"|..., csv_text: string }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { source, csv_text } = body;

  if (!source || !csv_text) {
    return NextResponse.json({ error: "source and csv_text required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: run } = await service
    .from("cleanup_runs")
    .select("client_link_id")
    .eq("id", runId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (run as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  try {
    const records = parseCsvToCanonical(source as ImportSource, csv_text);
    const result = await importRecords(
      service,
      (run as any).client_link_id,
      runId,
      records
    );
    return NextResponse.json({ ok: true, ...result, total_parsed: records.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
