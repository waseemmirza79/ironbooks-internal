import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken } from "@/lib/qbo";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import {
  parseCsv,
  normalizeCrmRows,
  detectDuplicates,
  type CrmSource,
} from "@/lib/hardcore-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/clients/[id]/hardcore-cleanup/start
 *
 * Body: { crm_source: "drip_jobs"|"jobber"|"generic", crm_filename: string,
 *         csv_text: string }
 *
 * Full pipeline in one call:
 *   1. Create run row
 *   2. Parse CSV → normalized CRM jobs
 *   3. Pull open QBO invoices
 *   4. Run duplicate detection
 *   5. Persist detected items
 *   6. Mark run as 'review'
 *
 * Owner bookkeeper / admin / lead only.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, is_active")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if ((client as any).is_active === false) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const crmSource = body.crm_source as CrmSource;
  const crmFilename = body.crm_filename || null;
  const csvText = body.csv_text || "";
  if (!["drip_jobs", "jobber", "generic"].includes(crmSource)) {
    return NextResponse.json({ error: "Invalid crm_source" }, { status: 400 });
  }
  if (!csvText.trim()) {
    return NextResponse.json({ error: "csv_text is required" }, { status: 400 });
  }
  // Vercel serverless function body limit is ~4.5MB. JSON-encoded CSV
  // adds overhead. Cap at 4MB raw to keep us well under.
  const MAX_CSV_BYTES = 4 * 1024 * 1024;
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return NextResponse.json(
      {
        error:
          `CSV is too large (${Math.round(Buffer.byteLength(csvText, "utf8") / 1024 / 1024)}MB). ` +
          `Max 4MB — split the export or filter to a smaller date range.`,
      },
      { status: 413 }
    );
  }

  // Zombie cleanup
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await service
    .from("hardcore_cleanup_runs" as any)
    .update({
      status: "failed",
      error_message: "Run did not complete (server timeout). Re-upload to retry.",
    } as any)
    .eq("client_link_id", clientLinkId)
    .in("status", ["uploading", "matching"])
    .lt("created_at", fiveMinAgo);

  // Create run row
  const { data: runIns, error: runErr } = await service
    .from("hardcore_cleanup_runs" as any)
    .insert({
      client_link_id: clientLinkId,
      created_by: user.id,
      status: "uploading",
      crm_source: crmSource,
      crm_filename: crmFilename,
    } as any)
    .select()
    .single();
  if (runErr || !runIns) {
    return NextResponse.json(
      { error: `Failed to create run: ${runErr?.message || "unknown"}` },
      { status: 500 }
    );
  }
  const runId = (runIns as any).id as string;
  const t0 = Date.now();

  try {
    // 1. Parse CSV
    const rawRows = parseCsv(csvText);
    if (rawRows.length === 0) {
      throw new Error("CSV had no data rows. Check the file and try again.");
    }
    const crmJobs = normalizeCrmRows(rawRows, crmSource);
    if (crmJobs.length === 0) {
      throw new Error(
        `CSV parsed ${rawRows.length} rows but none had a customer name. Check your column headers — expected "Customer", "Client", or similar.`
      );
    }

    // Persist CRM jobs AND capture their IDs in input order. Using
    // `.insert(arr).select("id")` returns rows in the same order they
    // were inserted — this is more reliable than re-querying by
    // created_at, which can race when batch inserts share a microsecond
    // timestamp.
    const BATCH = 200;
    const crmJobInsertRows = crmJobs.map((j) => ({
      run_id: runId,
      crm_job_id: j.crm_job_id,
      job_name: j.job_name,
      customer_name: j.customer_name,
      job_status: j.job_status,
      amount: j.amount,
      job_date: j.job_date,
      raw_row: j.raw_row,
    }));
    const persistedJobIds: string[] = [];
    for (let i = 0; i < crmJobInsertRows.length; i += BATCH) {
      const { data: returned, error: ce } = await service
        .from("hardcore_cleanup_crm_jobs" as any)
        .insert(crmJobInsertRows.slice(i, i + BATCH) as any)
        .select("id");
      if (ce) throw new Error(`CRM jobs insert failed: ${ce.message}`);
      for (const r of (returned as any[]) || []) {
        persistedJobIds.push(r.id);
      }
    }
    if (persistedJobIds.length !== crmJobs.length) {
      throw new Error(
        `CRM job persist returned ${persistedJobIds.length} IDs, expected ${crmJobs.length} — refusing to proceed with mismatched indices`
      );
    }

    // 2. Fetch QBO open invoices
    await service
      .from("hardcore_cleanup_runs" as any)
      .update({ status: "matching" } as any)
      .eq("id", runId);
    const accessToken = await getValidToken(clientLinkId, service as any);
    const invoices = await fetchOpenInvoices((client as any).qbo_realm_id, accessToken);

    // 3. Run duplicate detection
    const detection = detectDuplicates({ crmJobs, qboInvoices: invoices });

    // 4. Persist items (persistedJobIds was captured above in insert order)
    if (detection.duplicates.length > 0) {
      const itemRows = detection.duplicates.map((d) => ({
        run_id: runId,
        client_link_id: clientLinkId,
        item_type: "duplicate_invoice",
        qbo_invoice_id: d.qbo_invoice.qbo_invoice_id,
        qbo_invoice_doc_number: d.qbo_invoice.doc_number,
        qbo_invoice_date: d.qbo_invoice.txn_date,
        qbo_invoice_amount: d.qbo_invoice.total_amount,
        qbo_invoice_balance: d.qbo_invoice.balance,
        qbo_customer_id: d.qbo_invoice.customer_id,
        qbo_customer_name: d.qbo_invoice.customer_name,
        qbo_invoice_memo: null,
        matched_crm_job_id:
          d.matched_crm_job_index != null && persistedJobIds[d.matched_crm_job_index]
            ? persistedJobIds[d.matched_crm_job_index]
            : null,
        surviving_qbo_invoice_id: d.surviving_qbo_invoice.qbo_invoice_id,
        surviving_qbo_invoice_doc_number: d.surviving_qbo_invoice.doc_number,
        confidence: d.confidence,
        reasoning: d.reasoning,
        resolution: "pending",
      }));
      for (let i = 0; i < itemRows.length; i += BATCH) {
        const { error: ie } = await service
          .from("hardcore_cleanup_items" as any)
          .insert(itemRows.slice(i, i + BATCH) as any);
        if (ie) throw new Error(`Items insert failed: ${ie.message}`);
      }
    }

    const totalPhantom = detection.duplicates.reduce(
      (s, d) => s + (d.qbo_invoice.balance ?? d.qbo_invoice.total_amount ?? 0),
      0
    );

    await service
      .from("hardcore_cleanup_runs" as any)
      .update({
        status: "review",
        crm_jobs_uploaded: crmJobs.length,
        qbo_invoices_scanned: invoices.length,
        duplicates_detected: detection.duplicates.length,
        total_phantom_ar: Math.round(totalPhantom * 100) / 100,
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", runId);

    return NextResponse.json({
      ok: true,
      run_id: runId,
      crm_jobs_uploaded: crmJobs.length,
      qbo_invoices_scanned: invoices.length,
      duplicates_detected: detection.duplicates.length,
      total_phantom_ar: Math.round(totalPhantom * 100) / 100,
      customer_summary: detection.customerSummary,
    });
  } catch (err: any) {
    await service
      .from("hardcore_cleanup_runs" as any)
      .update({
        status: "failed",
        error_message: err?.message || String(err),
        duration_ms: Date.now() - t0,
      } as any)
      .eq("id", runId);
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
