import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/bank-rules-fleet
 *
 * Fleet-wide bank-rule status keyed on DOWNLOAD activity. Downloading the
 * .xls is what flips bank_rules.pushed_to_qbo=true + pushed_to_qbo_at, so a
 * rule the bookkeeper never downloaded is one we can assume was never applied
 * in QBO. For every active client with SNAP rules: total rules, how many were
 * never downloaded, and the last download time. "not_downloaded" (any
 * never-downloaded rule) is the actionable list — those clients still need
 * their .xls downloaded → old QBO rules cleared → imported (QBO's API can't
 * read/delete rules, so the clear is a manual step in the apply flow).
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

  type Agg = { total: number; not_downloaded: number; last_downloaded_at: string | null };
  const byClient = new Map<string, Agg>();
  for (const r of ((rules as any[]) || [])) {
    if (!r.client_link_id) continue;
    const a = byClient.get(r.client_link_id) || { total: 0, not_downloaded: 0, last_downloaded_at: null };
    a.total++;
    if (!r.pushed_to_qbo) a.not_downloaded++;
    if (r.pushed_to_qbo_at && (!a.last_downloaded_at || r.pushed_to_qbo_at > a.last_downloaded_at)) {
      a.last_downloaded_at = r.pushed_to_qbo_at;
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
          not_downloaded: a.not_downloaded,
          last_downloaded_at: a.last_downloaded_at,
          status: a.not_downloaded > 0 ? "not_downloaded" : "downloaded",
        };
      });
  }

  // Actionable first (not_downloaded), then most-undownloaded, then name.
  rows.sort((x, y) => {
    if (x.status !== y.status) return x.status === "not_downloaded" ? -1 : 1;
    if (y.not_downloaded !== x.not_downloaded) return y.not_downloaded - x.not_downloaded;
    return String(x.client_name).localeCompare(String(y.client_name));
  });

  const summary = {
    clients_with_rules: rows.length,
    not_downloaded: rows.filter((r) => r.status === "not_downloaded").length,
    total_rules: rows.reduce((s, r) => s + r.total_rules, 0),
  };

  return NextResponse.json({ summary, rows });
}
