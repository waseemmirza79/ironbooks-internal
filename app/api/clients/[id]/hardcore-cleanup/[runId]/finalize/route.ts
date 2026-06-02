import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createJournalEntry, fetchAllAccounts, getValidToken, qboRateLimiter } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * POST /api/clients/[id]/hardcore-cleanup/[runId]/finalize
 *
 * Pushes every resolved duplicate to QBO. Two QBO actions depending on
 * the bookkeeper's chosen resolution:
 *
 *   je_writeoff → JE: Dr <target account>  Cr A/R  (with customer entity)
 *                One JE per invoice (so the audit trail is clean +
 *                you can untangle individual mistakes later).
 *                Use for: filed-period invoices we can't void.
 *
 *   direct_void → Invoice.void via QBO's invoice operation=void endpoint.
 *                Zeros the balance + amount, leaves the doc visible.
 *                Use for: current-period invoices that haven't been
 *                reported on yet.
 *
 *   keep / manual → no-op, marked executed for tracking.
 *
 * Per-item try/catch — one bad invoice doesn't poison the batch.
 */
const NO_QBO_RESOLUTIONS = new Set(["keep", "manual"]);
const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> }
) {
  const { id: clientLinkId, runId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: run } = await service
    .from("hardcore_cleanup_runs" as any)
    .select("*")
    .eq("id", runId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: items } = await service
    .from("hardcore_cleanup_items" as any)
    .select("*")
    .eq("run_id", runId)
    .neq("resolution", "pending")
    .neq("resolution", "executed")
    .neq("resolution", "failed");
  const queue = (items as any[]) || [];

  if (queue.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No resolved items to execute.",
      executed: 0,
      failed: 0,
    });
  }

  let accessToken: string;
  let allAccounts;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return NextResponse.json(
      { error: `QBO bootstrap failed: ${err?.message || String(err)}` },
      { status: 500 }
    );
  }
  const accountById = new Map(allAccounts.map((a) => [a.Id, a]));

  await service
    .from("hardcore_cleanup_runs" as any)
    .update({ status: "finalizing" } as any)
    .eq("id", runId);

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const today = new Date().toISOString().slice(0, 10);

  let executed = 0;
  let failed = 0;
  const results: any[] = [];

  async function qboCall<T = any>(path: string, body?: any, method = "POST"): Promise<T> {
    await qboRateLimiter.throttle((client as any).qbo_realm_id);
    const res = await fetch(
      `${QBO_BASE}/${(client as any).qbo_realm_id}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      }
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`QBO ${path} failed ${res.status}: ${errBody}`);
    }
    return res.json();
  }

  for (const item of queue) {
    try {
      if (NO_QBO_RESOLUTIONS.has(item.resolution)) {
        await service
          .from("hardcore_cleanup_items" as any)
          .update({ resolution: "executed", resolved_at: new Date().toISOString() } as any)
          .eq("id", item.id);
        executed++;
        results.push({ id: item.id, type: "no-op", status: "ok" });
        continue;
      }

      if (item.resolution === "direct_void") {
        // Re-fetch the invoice to get its current SyncToken, then call
        // the void operation.
        const query = encodeURIComponent(
          `SELECT * FROM Invoice WHERE Id = '${item.qbo_invoice_id}'`
        );
        const qData: any = await qboCall(`/query?query=${query}`, undefined, "GET");
        const inv = qData?.QueryResponse?.Invoice?.[0];
        if (!inv) {
          throw new Error(`Invoice ${item.qbo_invoice_id} not found in QBO (may already be deleted)`);
        }
        const voidPayload = { Id: inv.Id, SyncToken: inv.SyncToken };
        const voidRes: any = await qboCall(
          `/invoice?operation=void&minorversion=70`,
          voidPayload
        );
        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            resolution_je_id: null,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: "void",
          status: "ok",
          new_sync_token: voidRes?.Invoice?.SyncToken,
        });
        continue;
      }

      if (item.resolution === "je_writeoff") {
        const target = accountById.get(item.resolution_target_account_id);
        if (!target) {
          throw new Error(
            `Target account ${item.resolution_target_account_id} not found in QBO`
          );
        }
        if (target.Active === false) {
          throw new Error(`Target account "${target.Name}" is inactive — pick another`);
        }

        // We need the invoice's A/R account + customer for the credit line
        const query = encodeURIComponent(
          `SELECT * FROM Invoice WHERE Id = '${item.qbo_invoice_id}'`
        );
        const qData: any = await qboCall(`/query?query=${query}`, undefined, "GET");
        const inv = qData?.QueryResponse?.Invoice?.[0];
        if (!inv) {
          throw new Error(`Invoice ${item.qbo_invoice_id} not found in QBO`);
        }
        const arRef = inv.ARAccountRef;
        const customerRef = inv.CustomerRef;
        if (!arRef?.value) throw new Error("Invoice has no A/R account ref");
        if (!customerRef?.value) throw new Error("Invoice has no customer ref");

        const amount = Number(item.qbo_invoice_balance ?? item.qbo_invoice_amount ?? 0);
        if (amount <= 0) {
          throw new Error("Invoice balance/amount is zero — nothing to write off");
        }

        // JE body — Dr Bad Debt, Cr A/R (with customer entity)
        const jeBody: any = {
          TxnDate: today,
          PrivateNote:
            `Ironbooks Hardcore BS Cleanup (by ${bookkeeperName}) — ` +
            `write off duplicate invoice ${inv.DocNumber || inv.Id} ` +
            `(survivor: ${item.surviving_qbo_invoice_doc_number || item.surviving_qbo_invoice_id || "?"})`,
          Line: [
            {
              DetailType: "JournalEntryLineDetail",
              Amount: Number(amount.toFixed(2)),
              Description: `Write off ${inv.DocNumber || inv.Id}`,
              JournalEntryLineDetail: {
                PostingType: "Debit",
                AccountRef: { value: target.Id, name: target.Name },
              },
            },
            {
              DetailType: "JournalEntryLineDetail",
              Amount: Number(amount.toFixed(2)),
              Description: `Clear A/R for duplicate invoice ${inv.DocNumber || inv.Id}`,
              JournalEntryLineDetail: {
                PostingType: "Credit",
                AccountRef: { value: arRef.value, name: arRef.name },
                Entity: {
                  Type: "Customer",
                  EntityRef: { value: customerRef.value, name: customerRef.name },
                },
              },
            },
          ],
        };
        const jeData: any = await qboCall(`/journalentry?minorversion=70`, jeBody);
        const jeId = jeData?.JournalEntry?.Id;
        if (!jeId) throw new Error("QBO returned no JE Id");
        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolution_je_id: jeId,
            resolved_at: new Date().toISOString(),
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({ id: item.id, type: "je_writeoff", status: "ok", je_id: jeId });
        continue;
      }

      // ─── V2 resolutions (Migration 44) ────────────────────────────────
      // ask_client — generate email draft for the bookkeeper to copy/paste.
      // Body lives in finalize_results so the UI can render the email modal
      // after finalize completes.
      if (item.resolution === "ask_client") {
        const emailDraft = buildAskClientEmail({
          customerName: item.uf_customer_name || "(unknown customer)",
          amount: Number(item.uf_payment_amount || 0),
          date: item.uf_payment_date || "",
          memo: item.qbo_invoice_memo || "",
          clientName: (client as any).client_name || "this client",
        });
        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            // Stash the email body in resolution_notes so the bookkeeper
            // can retrieve it later. Real V2 would push to a separate
            // emails table for tracking.
            resolution_notes: emailDraft.text,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: "ask_client",
          status: "ok",
          email_subject: emailDraft.subject,
          email_text: emailDraft.text,
          customer: item.uf_customer_name,
          amount: item.uf_payment_amount,
        });
        continue;
      }

      // push_invoice + apply_payment — V1 ships these as manual handoff.
      // Mark item as 'executed' so the bookkeeper sees it processed, but
      // record the proposed QBO payload in resolution_notes so they can
      // do the work manually in QBO. V2 (#73) will replace this branch
      // with real createInvoice / applyPayment calls.
      if (item.resolution === "push_invoice" || item.resolution === "apply_payment") {
        const handoffNote =
          item.resolution === "push_invoice"
            ? `MANUAL HANDOFF (V1): create invoice in QBO for ${item.qbo_customer_name || "(no customer)"} — $${Number(item.uf_payment_amount || 0).toFixed(2)}. ${item.reasoning || ""}`
            : `MANUAL HANDOFF (V1): apply UF payment ${item.uf_payment_id || ""} ($${Number(item.uf_payment_amount || 0).toFixed(2)}) from ${item.uf_customer_name || "(no customer)"} on ${item.uf_payment_date || ""} to ${Array.isArray(item.crm_job_ids) ? item.crm_job_ids.length : 1} CRM job(s). ${item.reasoning || ""}`;
        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            resolution_notes: handoffNote,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: item.resolution,
          status: "manual_handoff_v1",
          note: handoffNote,
          customer: item.qbo_customer_name || item.uf_customer_name,
          amount: item.uf_payment_amount,
        });
        continue;
      }

      throw new Error(`Unknown resolution ${item.resolution}`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      await service
        .from("hardcore_cleanup_items" as any)
        .update({ resolution: "failed", execution_error: msg } as any)
        .eq("id", item.id);
      failed++;
      results.push({ id: item.id, status: "failed", error: msg });
    }
  }

  const finalStatus = failed > 0 && executed === 0 ? "failed" : "finalized";
  await service
    .from("hardcore_cleanup_runs" as any)
    .update({
      status: finalStatus,
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
      duplicates_executed: executed,
      finalize_results: { executed, failed, results },
    } as any)
    .eq("id", runId);

  return NextResponse.json({ ok: true, executed, failed, results });
}

/**
 * Build a copy-paste-ready "ask the client" email for an unmatched UF
 * deposit. Inlined here rather than extracted into lib/uf-audit-email.ts
 * because (a) it's deposit-specific, not multi-customer like UF Audit's
 * version, (b) we want to keep the V1 ship surface tight.
 *
 * V2 (#73) can refactor toward a shared library if a third caller appears.
 */
function buildAskClientEmail(opts: {
  customerName: string;
  amount: number;
  date: string;
  memo: string;
  clientName: string;
}): { subject: string; text: string } {
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const subject = `Quick question about a ${fmtMoney(opts.amount)} deposit (${opts.date})`;

  const lines: string[] = [
    `Hi,`,
    ``,
    `We're cleaning up ${opts.clientName}'s books and found a deposit that doesn't have a clear job match:`,
    ``,
    `  • Date: ${opts.date || "(unknown)"}`,
    `  • Amount: ${fmtMoney(opts.amount)}`,
    `  • Customer (per QBO): ${opts.customerName}`,
  ];
  if (opts.memo) lines.push(`  • Memo: "${opts.memo}"`);
  lines.push(
    ``,
    `Can you let us know which option fits?`,
    ``,
    `  A) Payment for a specific job — please share the job # or invoice #`,
    `  B) Payment covering multiple jobs — share the job # / invoice #s and how it splits`,
    `  C) Not a customer payment (refund, owner contribution, transfer, etc.) — what is it?`,
    `  D) Not sure — let's hop on a call`,
    ``,
    `Short reply with the letter is fine.`,
    ``,
    `Thanks,`,
    `Ironbooks`
  );

  return { subject, text: lines.join("\n") };
}
