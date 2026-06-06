import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import {
  buildFleetReadiness,
  parsePeriodQuery,
} from "@/lib/month-end";
import { buildPackagesBulk } from "@/lib/month-end/package-builder";
import { requireSeniorMonthEnd, parseJsonBody } from "@/lib/month-end/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/month-end/packages
 * Body: { period_year, period_month, client_link_ids?: string[], build_all_ready?: boolean, force_rebuild?: boolean }
 */
export async function POST(request: Request) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  try {
    const body = parseJsonBody<{
      period_year?: number;
      period_month?: number;
      client_link_ids?: string[];
      build_all_ready?: boolean;
      force_rebuild?: boolean;
    }>(await request.json().catch(() => ({})));

    const period = parsePeriodQuery(
      body.period_year != null ? String(body.period_year) : null,
      body.period_month != null ? String(body.period_month) : null
    );
    const service = createServiceSupabase();

    let clientIds: string[] = Array.isArray(body.client_link_ids)
      ? body.client_link_ids.filter((id) => typeof id === "string")
      : [];

    if (body.build_all_ready) {
      const fleet = await buildFleetReadiness(service, period);
      clientIds = fleet.blocked
        .concat(fleet.ready)
        .filter((c) => c.operationallyReady && c.packageStatus !== "sent")
        .map((c) => c.clientLinkId);
    }

    if (!clientIds.length) {
      return NextResponse.json({ error: "No clients to build" }, { status: 400 });
    }

    const results = await buildPackagesBulk(
      service,
      clientIds,
      period,
      authResult.auth.userId
    );

    const built = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    return NextResponse.json({ built, failed, results });
  } catch (err: any) {
    console.error("[month-end/packages]", err);
    return NextResponse.json(
      { error: err?.message || "Package build failed" },
      { status: 500 }
    );
  }
}
