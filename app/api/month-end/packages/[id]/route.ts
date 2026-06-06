import { createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireSeniorMonthEnd, parseJsonBody } from "@/lib/month-end/api-auth";
import { AI_SUMMARY_MAX_LEN, AI_SUMMARY_MIN_LEN } from "@/lib/month-end/constants";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  const service = createServiceSupabase();

  const { data: pkg, error } = await service
    .from("month_end_packages")
    .select(
      "id, client_link_id, period_year, period_month, status, ai_summary, ai_summary_reviewed, send_error, pl_snapshot, bs_snapshot"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(pkg);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireSeniorMonthEnd();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  const body = parseJsonBody<{
    ai_summary?: string;
    ai_summary_reviewed?: boolean;
  }>(await request.json().catch(() => ({})));

  const service = createServiceSupabase();

  const { data: pkg } = await service
    .from("month_end_packages")
    .select("id, status, ai_summary")
    .eq("id", id)
    .maybeSingle();

  if (!pkg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((pkg as any).status === "sent") {
    return NextResponse.json({ error: "Already sent" }, { status: 400 });
  }
  if (["sending", "summary_pending"].includes((pkg as any).status)) {
    return NextResponse.json(
      { error: `Cannot edit while status is ${(pkg as any).status}` },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };

  if (typeof body.ai_summary === "string") {
    update.ai_summary = body.ai_summary.trim().slice(0, AI_SUMMARY_MAX_LEN);
  }

  if (body.ai_summary_reviewed === true) {
    const summary =
      typeof body.ai_summary === "string"
        ? body.ai_summary.trim()
        : ((pkg as any).ai_summary || "").trim();
    if (summary.length < AI_SUMMARY_MIN_LEN) {
      return NextResponse.json(
        { error: `Summary must be at least ${AI_SUMMARY_MIN_LEN} characters` },
        { status: 400 }
      );
    }
    update.ai_summary = summary;
    update.ai_summary_reviewed = true;
    update.ai_summary_reviewed_by = authResult.auth.userId;
    update.ai_summary_reviewed_at = now;
    update.status = "ready_to_send";
    update.send_error = null;
  } else if (body.ai_summary_reviewed === false) {
    update.ai_summary_reviewed = false;
    update.ai_summary_reviewed_by = null;
    update.ai_summary_reviewed_at = null;
    update.status = "draft";
  }

  const { error } = await service
    .from("month_end_packages")
    .update(update as any)
    .eq("id", id)
    .not("status", "eq", "sent");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
