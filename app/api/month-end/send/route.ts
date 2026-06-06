import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildFleetReadiness, parsePeriodQuery, deliverPackagesBulk } from "@/lib/month-end";
import { requireSeniorMonthEnd, parseJsonBody, appBaseUrl } from "@/lib/month-end/api-auth";
import { SEND_MAX_BATCH } from "@/lib/month-end/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  try {
    const body = parseJsonBody<{
      period_year?: number;
      period_month?: number;
      package_ids?: string[];
      send_all_ready?: boolean;
    }>(await request.json().catch(() => ({})));

    const period = parsePeriodQuery(
      body.period_year != null ? String(body.period_year) : null,
      body.period_month != null ? String(body.period_month) : null
    );
    const service = createServiceSupabase();

    let packageIds: string[] = Array.isArray(body.package_ids)
      ? body.package_ids.filter((id) => typeof id === "string")
      : [];

    if (body.send_all_ready) {
      const fleet = await buildFleetReadiness(service, period);
      packageIds = fleet.ready.map((c) => c.packageId!).filter(Boolean);
    }

    if (!packageIds.length) {
      return NextResponse.json({ error: "No packages to send" }, { status: 400 });
    }

    const { data: periodPackages } = await service
      .from("month_end_packages")
      .select("id")
      .eq("period_year", period.periodYear)
      .eq("period_month", period.periodMonth)
      .in("id", packageIds);

    packageIds = ((periodPackages || []) as { id: string }[]).map((p) => p.id);
    if (!packageIds.length) {
      return NextResponse.json(
        { error: "No packages match the requested period" },
        { status: 400 }
      );
    }

    if (packageIds.length > SEND_MAX_BATCH) {
      return NextResponse.json(
        {
          error: `Max ${SEND_MAX_BATCH} packages per request — split into multiple calls`,
          total_requested: packageIds.length,
        },
        { status: 400 }
      );
    }

    const { data: run, error: runError } = await service
      .from("month_end_delivery_runs")
      .insert({
        period_year: period.periodYear,
        period_month: period.periodMonth,
        started_by: authResult.auth.userId,
        total_clients: packageIds.length,
        status: "running",
      } as any)
      .select("id")
      .single();

    if (runError || !run?.id) {
      return NextResponse.json(
        { error: runError?.message || "Failed to create delivery run" },
        { status: 500 }
      );
    }

    const { sent, failed, skipped, results } = await deliverPackagesBulk(
      service,
      packageIds,
      authResult.auth.userId,
      appBaseUrl()
    );

    await service
      .from("month_end_delivery_runs")
      .update({
        status: sent === 0 && failed > 0 ? "failed" : "complete",
        sent_count: sent,
        failed_count: failed,
        skipped_count: skipped,
        error_summary: results
          .filter((r) => !r.ok)
          .map((r) => ({
            package_id: r.packageId,
            client: r.clientName,
            error: r.error,
          })),
        completed_at: new Date().toISOString(),
      } as any)
      .eq("id", run.id);

    return NextResponse.json({
      sent,
      failed,
      skipped,
      run_id: run.id,
      results,
    });
  } catch (err: any) {
    console.error("[month-end/send]", err);
    return NextResponse.json(
      { error: err?.message || "Bulk send failed" },
      { status: 500 }
    );
  }
}
