import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { buildFleetReadiness, parsePeriodQuery } from "@/lib/month-end";
import { generateSummariesBatch } from "@/lib/month-end/generate-summaries";
import { requireSeniorMonthEnd, parseJsonBody } from "@/lib/month-end/api-auth";
import { GENERATE_WAVE_SIZE } from "@/lib/month-end/constants";

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
      generate_all_drafts?: boolean;
      regenerate?: boolean;
    }>(await request.json().catch(() => ({})));

    const period = parsePeriodQuery(
      body.period_year != null ? String(body.period_year) : null,
      body.period_month != null ? String(body.period_month) : null
    );
    const service = createServiceSupabase();

    let packageIds: string[] = Array.isArray(body.package_ids)
      ? body.package_ids.filter((id) => typeof id === "string")
      : [];

    if (body.generate_all_drafts || !packageIds.length) {
      const fleet = await buildFleetReadiness(service, period);
      const { data: drafts } = await service
        .from("month_end_packages")
        .select("id, client_link_id, status, ai_summary")
        .eq("period_year", period.periodYear)
        .eq("period_month", period.periodMonth)
        .in("status", ["draft", "failed", "ready_to_send"]);

      const readyClientIds = new Set(
        fleet.blocked
          .concat(fleet.ready)
          .filter((c) => c.operationallyReady)
          .map((c) => c.clientLinkId)
      );

      packageIds = ((drafts || []) as any[])
        .filter((p) => readyClientIds.has(p.client_link_id))
        .filter((p) => !p.ai_summary?.trim() || body.regenerate)
        .filter((p) => !["sending", "summary_pending", "sent"].includes(p.status))
        .map((p) => p.id);
    }

    if (!packageIds.length) {
      return NextResponse.json({ error: "No packages to generate" }, { status: 400 });
    }

    const batch = packageIds.slice(0, GENERATE_WAVE_SIZE);
    const result = await generateSummariesBatch(service, batch);

    return NextResponse.json({
      ...result,
      remaining: Math.max(0, packageIds.length - GENERATE_WAVE_SIZE),
      message:
        packageIds.length > GENERATE_WAVE_SIZE
          ? `Processed ${GENERATE_WAVE_SIZE} — call again for remaining ${packageIds.length - GENERATE_WAVE_SIZE}.`
          : undefined,
    });
  } catch (err: any) {
    console.error("[month-end/generate-summaries]", err);
    return NextResponse.json(
      { error: err?.message || "Summary generation failed" },
      { status: 500 }
    );
  }
}
