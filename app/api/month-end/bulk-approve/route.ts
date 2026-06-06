import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildFleetReadiness, parsePeriodQuery } from "@/lib/month-end";
import { bulkApproveSummaries } from "@/lib/month-end/bulk-approve";
import { requireSeniorMonthEnd, parseJsonBody } from "@/lib/month-end/api-auth";
import { SEND_MAX_BATCH } from "@/lib/month-end/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/month-end/bulk-approve
 * Approve AI summaries in bulk (still requires non-empty summary text).
 */
export async function POST(request: Request) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  try {
    const body = parseJsonBody<{
      period_year?: number;
      period_month?: number;
      package_ids?: string[];
      approve_all_with_summary?: boolean;
    }>(await request.json().catch(() => ({})));

    const period = parsePeriodQuery(
      body.period_year != null ? String(body.period_year) : null,
      body.period_month != null ? String(body.period_month) : null
    );
    const service = createServiceSupabase();

    let packageIds: string[] = Array.isArray(body.package_ids)
      ? body.package_ids.filter((id) => typeof id === "string")
      : [];

    if (body.approve_all_with_summary || !packageIds.length) {
      const { data: candidates } = await service
        .from("month_end_packages")
        .select("id, ai_summary, status, ai_summary_reviewed")
        .eq("period_year", period.periodYear)
        .eq("period_month", period.periodMonth)
        .eq("ai_summary_reviewed", false)
        .in("status", ["draft", "failed"]);

      packageIds = ((candidates || []) as any[])
        .filter((p) => (p.ai_summary || "").trim().length >= 80)
        .map((p) => p.id);
    }

    if (!packageIds.length) {
      return NextResponse.json({ error: "No packages to approve" }, { status: 400 });
    }

    if (packageIds.length > SEND_MAX_BATCH) {
      packageIds = packageIds.slice(0, SEND_MAX_BATCH);
    }

    const fleet = await buildFleetReadiness(service, period);
    const operReadyPackageIds = new Set(
      fleet.blocked
        .concat(fleet.ready)
        .filter((c) => c.operationallyReady && c.packageId)
        .map((c) => c.packageId!)
    );
    packageIds = packageIds.filter((id) => operReadyPackageIds.has(id));

    if (!packageIds.length) {
      return NextResponse.json(
        { error: "No operationally-ready packages to approve" },
        { status: 400 }
      );
    }

    const result = await bulkApproveSummaries(
      service,
      packageIds,
      authResult.auth.userId
    );

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[month-end/bulk-approve]", err);
    return NextResponse.json(
      { error: err?.message || "Bulk approve failed" },
      { status: 500 }
    );
  }
}
