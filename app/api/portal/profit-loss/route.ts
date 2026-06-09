import { NextResponse } from "next/server";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";

/**
 * GET /api/portal/profit-loss?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns the P&L summary for an arbitrary date range. Powers the "Custom"
 * range option on the portal P&L page — the five standard ranges are
 * pre-fetched server-side, but a custom range is fetched on demand.
 *
 * Auth: only this client's portal user can hit this; the QBO token + realm
 * come from resolvePortalContext, NOT from any request parameter. A client
 * can only ever pull THEIR own books, regardless of what they put in the URL.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Guard against absurd ranges that would hammer QBO / time out.
const MAX_RANGE_DAYS = 366 * 3;

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: "Start date must be on or before the end date." }, { status: 400 });
  }
  const spanDays = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: "Range too large — keep it under 3 years." }, { status: 400 });
  }

  try {
    const data = await fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, start, end);
    return NextResponse.json({ ok: true, profit_loss: data, start, end });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Couldn't load P&L: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
