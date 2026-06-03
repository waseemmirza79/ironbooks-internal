import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { buildCleanupReportData } from "@/lib/cleanup-report-data";
import { CleanupReportPDF } from "@/lib/cleanup-report-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/portal/cleanup-report?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Portal-side twin of /api/reports/cleanup/[client_link_id]. Difference:
 * client_link_id is derived from the signed-in portal user's session via
 * resolvePortalContext — clients literally cannot request other clients'
 * reports. The internal bookkeeper route stays as-is for bookkeepers
 * working multi-client.
 *
 * Both routes call the same buildCleanupReportData + CleanupReportPDF
 * so the document is byte-identical to what the bookkeeper sees.
 */
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

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end query params (YYYY-MM-DD) are required" },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json(
      { error: "start and end must be YYYY-MM-DD" },
      { status: 400 }
    );
  }
  if (new Date(end).getTime() < new Date(start).getTime()) {
    return NextResponse.json(
      { error: "end date must be >= start date" },
      { status: 400 }
    );
  }

  const originUrl =
    process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;

  let data;
  try {
    data = await buildCleanupReportData({
      client_link_id: ctx.clientLinkId,
      period_start: start,
      period_end: end,
      // For portal-generated reports, attribute to the real admin when
      // impersonating, else to the client's user. Either way the report
      // header shows the client's own bookkeeper assignment (resolved
      // inside buildCleanupReportData from client_links).
      bookkeeper_user_id: ctx.realUserId || ctx.userId,
      origin_url: originUrl,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = (await renderToBuffer(
      // @ts-expect-error react-pdf accepts a Document element here
      React.createElement(CleanupReportPDF, { data })
    )) as Buffer;
  } catch (err: any) {
    console.error("[portal/cleanup-report] PDF render failed:", err);
    return NextResponse.json(
      { error: `PDF generation failed: ${err.message}` },
      { status: 500 }
    );
  }

  const safeClient = data.client_name.replace(/[^A-Za-z0-9 .\-_]+/g, "").trim() || "Client";
  const asciiFilename = `Ironbooks Cleanup - ${safeClient} - ${start}_${end}.pdf`;
  const utf8Filename = `Ironbooks Cleanup — ${safeClient} — ${start}_${end}.pdf`;
  const encodedUtf8 = encodeURIComponent(utf8Filename);

  return new NextResponse(pdfBuffer as any, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedUtf8}`,
      "Content-Length": String(pdfBuffer.length),
      "Cache-Control": "no-store",
    },
  });
}
