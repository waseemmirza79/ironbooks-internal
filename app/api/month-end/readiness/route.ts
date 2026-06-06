import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildFleetReadiness, parsePeriodQuery } from "@/lib/month-end";
import { requireSeniorMonthEnd } from "@/lib/month-end/api-auth";
import { recoverStaleMonthEndPackages } from "@/lib/month-end/claim";

export const dynamic = "force-dynamic";

/**
 * GET /api/month-end/readiness?period_year=2026&period_month=1
 */
export async function GET(request: Request) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  try {
    const url = new URL(request.url);
    const period = parsePeriodQuery(
      url.searchParams.get("period_year"),
      url.searchParams.get("period_month")
    );

    const service = createServiceSupabase();
    await recoverStaleMonthEndPackages(service);
    const fleet = await buildFleetReadiness(service, period);

    return NextResponse.json(fleet);
  } catch (err: any) {
    console.error("[month-end/readiness]", err);
    return NextResponse.json(
      { error: err?.message || "Failed to load readiness" },
      { status: 500 }
    );
  }
}
