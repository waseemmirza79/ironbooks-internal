import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/rules/export-qbo/[client_link_id]/stats
 *
 * Lightweight companion to the .xls export endpoint. Returns counts so
 * the UI can show "5 new rules since last export" without actually
 * generating the workbook (which is wasted work if Lisa just wants
 * to glance at status).
 *
 * Response shape:
 *   {
 *     total_active: number,           // every status='active' rule
 *     never_exported: number,         // pushed_to_qbo IS NOT TRUE
 *     last_exported_at: string|null,  // ISO timestamp of most recent export
 *   }
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ client_link_id: string }> }
) {
  const { client_link_id } = await params;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  // Two cheap queries — head:true returns count without the rows
  const [totalRes, newRes, lastRes] = await Promise.all([
    service
      .from("bank_rules")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", client_link_id)
      .eq("status", "active"),
    service
      .from("bank_rules")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", client_link_id)
      .eq("status", "active")
      .or("pushed_to_qbo.is.null,pushed_to_qbo.eq.false"),
    service
      .from("bank_rules")
      .select("pushed_to_qbo_at")
      .eq("client_link_id", client_link_id)
      .eq("status", "active")
      .not("pushed_to_qbo_at", "is", null)
      .order("pushed_to_qbo_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    total_active: totalRes.count ?? 0,
    never_exported: newRes.count ?? 0,
    last_exported_at: (lastRes.data as any)?.pushed_to_qbo_at ?? null,
  });
}
