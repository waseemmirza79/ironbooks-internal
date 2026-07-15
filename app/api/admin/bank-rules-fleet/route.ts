import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/bank-rules-fleet
 *
 * Fleet-wide bank-rule status. For every active client with SNAP rules:
 * how many rules we've built, how many haven't been imported into QBO yet
 * (never_imported), and when they were last exported. "needs_import" (any
 * un-imported rule) is the actionable list — those clients still need our
 * rules applied + their old QBO rules cleared (QBO's API can't read/delete
 * rules, so the clear is a manual step in the per-client apply flow).
 *
 * Admin/lead only. One aggregate query over active rules — no per-client
 * fan-out.
 */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Admin or lead only" }, { status: 403 });
  }

  const { data: rules, error } = await (service as any)
    .from("bank_rules")
    .select("client_link_id, pushed_to_qbo, pushed_to_qbo_at")
    .eq("status", "active");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Agg = { total: number; never_imported: number; last_exported_at: string | null };
  const byClient = new Map<string, Agg>();
  for (const r of ((rules as any[]) || [])) {
    if (!r.client_link_id) continue;
    const a = byClient.get(r.client_link_id) || { total: 0, never_imported: 0, last_exported_at: null };
    a.total++;
    if (!r.pushed_to_qbo) a.never_imported++;
    if (r.pushed_to_qbo_at && (!a.last_exported_at || r.pushed_to_qbo_at > a.last_exported_at)) {
      a.last_exported_at = r.pushed_to_qbo_at;
    }
    byClient.set(r.client_link_id, a);
  }

  const ids = [...byClient.keys()];
  let rows: any[] = [];
  if (ids.length) {
    const { data: clients } = await service
      .from("client_links")
      .select("id, client_name, is_active")
      .in("id", ids);
    const nameById = new Map(((clients as any[]) || []).filter((c) => c.is_active !== false).map((c) => [c.id, c.client_name]));
    rows = ids
      .filter((id) => nameById.has(id))
      .map((id) => {
        const a = byClient.get(id)!;
        return {
          client_link_id: id,
          client_name: nameById.get(id),
          total_rules: a.total,
          never_imported: a.never_imported,
          last_exported_at: a.last_exported_at,
          status: a.never_imported > 0 ? "needs_import" : "up_to_date",
        };
      });
  }

  // Actionable first (needs_import), then most rules, then name.
  rows.sort((x, y) => {
    if (x.status !== y.status) return x.status === "needs_import" ? -1 : 1;
    if (y.never_imported !== x.never_imported) return y.never_imported - x.never_imported;
    return String(x.client_name).localeCompare(String(y.client_name));
  });

  const summary = {
    clients_with_rules: rows.length,
    needs_import: rows.filter((r) => r.status === "needs_import").length,
    total_rules: rows.reduce((s, r) => s + r.total_rules, 0),
  };

  return NextResponse.json({ summary, rows });
}
