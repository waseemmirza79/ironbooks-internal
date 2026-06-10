import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { buildCleanupReportData } from "@/lib/cleanup-report-data";
import { CleanupReportPDF } from "@/lib/cleanup-report-pdf";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/portal/cleanup-report/generate — body { start, end }
 *
 * Client-initiated cleanup report. Same data + PDF pipeline as the
 * on-demand GET /api/portal/cleanup-report download, but instead of
 * streaming the file back we SAVE it to the client's folder in the
 * private client-uploads bucket:
 *
 *   <client_link_id>/reports/<ts>-Cleanup-Report-<start>-to-<end>.pdf
 *
 * The portal Cleanup Reports page lists that folder, so the report
 * appears in "Your generated reports" the moment this returns — and
 * stays there (unlike the on-demand downloads, which are never stored).
 * Downloads go through /api/client-files/download, which enforces the
 * client_link_id path-prefix ownership check.
 */
export async function POST(request: Request) {
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

  let payload: { start?: string; end?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const start = payload.start || "";
  const end = payload.end || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "start and end must be YYYY-MM-DD" }, { status: 400 });
  }
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (endMs < startMs) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
  }
  if (endMs - startMs > 366 * 24 * 3600 * 1000) {
    return NextResponse.json(
      { error: "Reports cover at most one year — pick a shorter period" },
      { status: 400 }
    );
  }
  if (startMs < new Date("2000-01-01").getTime() || startMs > Date.now()) {
    return NextResponse.json({ error: "Start date is out of range" }, { status: 400 });
  }

  const url = new URL(request.url);
  const originUrl = process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;

  let data;
  try {
    data = await buildCleanupReportData({
      client_link_id: ctx.clientLinkId,
      period_start: start,
      period_end: end,
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
    console.error("[portal/cleanup-report/generate] PDF render failed:", err);
    return NextResponse.json({ error: `PDF generation failed: ${err.message}` }, { status: 500 });
  }

  // Persist under the client's own prefix. Timestamp prefix keeps repeat
  // generations of the same period as separate files; the download
  // gateway strips it from the suggested filename.
  const path = `${ctx.clientLinkId}/reports/${Date.now()}-Cleanup-Report-${start}-to-${end}.pdf`;
  const service = createServiceSupabase();
  const { error: uploadErr } = await service.storage
    .from(CLIENT_UPLOADS_BUCKET)
    .upload(path, pdfBuffer, { contentType: "application/pdf" });
  if (uploadErr) {
    console.error(`[portal/cleanup-report/generate] storage upload failed: ${uploadErr.message}`);
    return NextResponse.json(
      { error: "Report was built but couldn't be saved — try again" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, path, start, end });
}
