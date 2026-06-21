import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { qboRequest } from "@/lib/qbo";
import { rowToJob } from "../../jobs/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function num(v: any): number {
  const n = parseFloat(String(v ?? "").replace(/[,$\s]/g, "").replace(/^\((.+)\)$/, "-$1"));
  return isNaN(n) ? 0 : n;
}

/** Per-job revenue + COGS from a P&L segmented by Classes (or Customers). */
async function fetchQboJobs(
  realmId: string,
  accessToken: string,
  start: string,
  end: string,
  dimension: "Classes" | "Customers"
): Promise<{ name: string; revenue: number; cogs: number }[]> {
  const params = new URLSearchParams({
    start_date: start,
    end_date: end,
    accounting_method: "Accrual",
    summarize_column_by: dimension,
  });
  let report: any;
  try {
    report = await qboRequest(realmId, accessToken, `/reports/ProfitAndLoss?${params.toString()}`);
  } catch {
    return [];
  }
  const cols: any[] = report?.Columns?.Column || [];
  const jobCols = cols.slice(1).map((c: any, i: number) => ({
    idx: i + 1,
    title: String(c?.ColTitle || "").trim(),
    isTotal: String(c?.ColTitle || "").trim().toLowerCase() === "total",
  }));
  const summaries = new Map<string, any[]>();
  const collect = (rows: any[]) => {
    for (const r of rows || []) {
      if (r?.Summary?.ColData) {
        const label = String(r.Summary.ColData[0]?.value || "").trim().toLowerCase();
        if (label && !summaries.has(label)) summaries.set(label, r.Summary.ColData);
      }
      if (r?.Rows?.Row) collect(r.Rows.Row);
    }
  };
  collect(report?.Rows?.Row || []);
  const incomeRow = summaries.get("total income") || summaries.get("total revenue");
  const cogsRow = summaries.get("total cost of goods sold") || summaries.get("total cogs");

  const out: { name: string; revenue: number; cogs: number }[] = [];
  for (const jc of jobCols) {
    if (jc.isTotal) continue;
    const revenue = incomeRow ? num(incomeRow[jc.idx]?.value) : 0;
    const cogs = cogsRow ? num(cogsRow[jc.idx]?.value) : 0;
    if (revenue === 0 && cogs === 0) continue;
    if (/not specified|unspecified|^$/i.test(jc.title)) continue; // skip the overhead bucket
    out.push({ name: jc.title, revenue, cogs });
  }
  return out;
}

/**
 * POST /api/portal/job-costing/import/quickbooks   { start, end }
 *
 * Pulls a P&L segmented by Class (or Customer if classes are empty) and creates
 * one DRAFT job per class/customer: price = revenue, labor = COGS, materials =
 * 0 (QBO doesn't cleanly split paint vs labor — the client refines). Returns
 * the created jobs.
 */
export async function POST(request: Request) {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: ctxResult.message || "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  const body = await request.json().catch(() => ({} as any));
  let start = body.start;
  let end = body.end;
  if (!ISO.test(start || "") || !ISO.test(end || "") || start > end) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    start = `${now.getFullYear()}-01-01`;
    end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  let rows: { name: string; revenue: number; cogs: number }[] = [];
  try {
    rows = await fetchQboJobs(ctx.qboRealmId, ctx.accessToken, start, end, "Classes");
    if (rows.length === 0) {
      rows = await fetchQboJobs(ctx.qboRealmId, ctx.accessToken, start, end, "Customers");
    }
  } catch (e: any) {
    return NextResponse.json({ error: `QuickBooks pull failed — ${e?.message || "unknown"}` }, { status: 500 });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No class- or customer-tagged jobs found in QuickBooks for that range.", imported: 0 },
      { status: 400 }
    );
  }

  const toInsert = rows.map((j) => ({
    client_link_id: ctx.clientLinkId,
    created_by: ctx.userId,
    job_name: j.name.slice(0, 200),
    crew: null,
    job_date: end,
    job_price: Math.round(j.revenue),
    sales_tax: 0,
    materials_cost: 0,
    labor_cost: Math.round(j.cogs),
    labor_lines: [],
    budgeted_hours: 0,
    actual_hours: 0,
    notes: "Imported from QuickBooks — split paint vs labor as needed.",
  }));

  const service = createServiceSupabase();
  const { data, error } = await (service as any).from("jc_jobs").insert(toInsert).select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    imported: (data as any[])?.length || 0,
    jobs: ((data as any[]) || []).map(rowToJob),
  });
}
