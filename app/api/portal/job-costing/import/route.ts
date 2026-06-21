import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { jobBodyToRow, rowToJob } from "../jobs/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/portal/job-costing/import   (multipart form-data: file=<csv|xlsx>)
 *
 * Bulk-import jobs from a CSV or Excel export (e.g. the "Job Cost Tracker"
 * spreadsheet). SheetJS reads both formats. We auto-detect the header row
 * (the row containing a "job name"/"job price" header), map columns by fuzzy
 * header match, and insert one jc_jobs row per data row. Rows without a job
 * name are skipped. Returns counts so the UI can report the result.
 */

// header text (lowercased) → JobInput field. First match wins.
const FIELD_MATCHERS: Array<{ field: string; re: RegExp; numeric?: boolean; date?: boolean }> = [
  { field: "jobName", re: /job\s*name|^job$|customer|client/ },
  { field: "crew", re: /crew/ },
  { field: "jobDate", re: /date|month|completed/, date: true },
  { field: "jobPrice", re: /job\s*price|price|revenue|contract|amount/, numeric: true },
  { field: "salesTax", re: /sales\s*tax|^tax/, numeric: true },
  { field: "materialsCost", re: /paint|material|supplies/, numeric: true },
  { field: "laborCost", re: /labou?r/, numeric: true },
  { field: "budgetedHours", re: /budget.*h(ou)?rs?|budgeted/, numeric: true },
  { field: "actualHours", re: /actual.*h(ou)?rs?|actual/, numeric: true },
  { field: "notes", re: /notes?|comment/ },
];

function num(v: any): number {
  if (typeof v === "number") return v;
  const n = parseFloat(
    String(v ?? "").replace(/[,$%\s]/g, "").replace(/^\((.+)\)$/, "-$1")
  );
  return isNaN(n) ? 0 : n;
}
function toIso(v: any): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10); // unparseable → today (editable)
}

export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  let buf: Buffer;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof (file as any).arrayBuffer !== "function") {
      return NextResponse.json({ error: "Attach a CSV or Excel file (field 'file')." }, { status: 400 });
    }
    buf = Buffer.from(await (file as File).arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Couldn't read the uploaded file." }, { status: 400 });
  }

  let grid: any[][];
  try {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: "" });
  } catch {
    return NextResponse.json({ error: "Couldn't parse the file — make sure it's a .csv or .xlsx." }, { status: 400 });
  }

  // Find the header row: the first row that has a "job name"/"job price" cell.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const cells = (grid[i] || []).map((c) => String(c || "").toLowerCase());
    if (cells.some((c) => /job\s*name/.test(c)) || cells.some((c) => /job\s*price/.test(c))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return NextResponse.json(
      { error: "Couldn't find the header row. Use the template (it needs a 'Job Name' and 'Job Price' column)." },
      { status: 400 }
    );
  }

  // Map each column index → JobInput field (first matcher to claim it wins).
  const headers = (grid[headerIdx] || []).map((c) => String(c || "").trim().toLowerCase());
  const colField: Record<number, { field: string; numeric?: boolean; date?: boolean }> = {};
  const used = new Set<string>();
  headers.forEach((h, idx) => {
    if (!h) return;
    for (const m of FIELD_MATCHERS) {
      if (used.has(m.field)) continue;
      if (m.re.test(h)) {
        colField[idx] = { field: m.field, numeric: m.numeric, date: m.date };
        used.add(m.field);
        break;
      }
    }
  });
  if (!used.has("jobName")) {
    return NextResponse.json({ error: "No 'Job Name' column found." }, { status: 400 });
  }

  const MAX_ROWS = 1000;
  const toInsert: any[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < grid.length && toInsert.length < MAX_ROWS; i++) {
    const r = grid[i] || [];
    const mapped: any = {};
    for (const [idxStr, def] of Object.entries(colField)) {
      const v = r[Number(idxStr)];
      mapped[def.field] = def.numeric ? num(v) : def.date ? toIso(v) : String(v ?? "").trim();
    }
    if (!mapped.jobName || !String(mapped.jobName).trim()) {
      skipped++;
      continue;
    }
    const row = jobBodyToRow(mapped);
    toInsert.push({ ...row, client_link_id: ctx.clientLinkId, created_by: ctx.userId });
  }

  if (toInsert.length === 0) {
    return NextResponse.json({ error: "No job rows found under the header.", imported: 0, skipped }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data, error } = await (service as any).from("jc_jobs").insert(toInsert).select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    imported: (data as any[])?.length || 0,
    skipped,
    jobs: ((data as any[]) || []).map(rowToJob),
  });
}
