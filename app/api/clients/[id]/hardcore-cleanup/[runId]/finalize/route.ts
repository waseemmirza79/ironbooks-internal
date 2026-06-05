import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import {
  createJournalEntry,
  fetchAllAccounts,
  getValidToken,
  qboRateLimiter,
  createInvoice,
  applyPaymentToInvoices,
  findCustomerByName,
  findByPrivateNoteToken,
  fetchOpenInvoicesForCustomer,
} from "@/lib/qbo";

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
  // Each item can override the posting date via resolve's resolution_je_date.
  // Falls back to today when null. Used in JE TxnDate + push_invoice TxnDate.
  const postDate = (item: any) =>
    item?.resolution_je_date && /^\d{4}-\d{2}-\d{2}$/.test(item.resolution_je_date)
      ? item.resolution_je_date
      : today;

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
      // ─── Pre-flight: resolution must be compatible with item shape ───
      //
      // Cody Ruane / Clean Cut Painters hit this 3 times in a row: the
      // bookkeeper picked direct_void on a `missing_invoice` item, finalize
      // dutifully ran `SELECT * FROM Invoice WHERE Id='null'`, QBO returned
      // 400 "Invalid ID", item went to `failed`. Same dance every retry.
      //
      // Catch the impossible combinations BEFORE calling QBO so the error
      // message tells the bookkeeper what to do instead, not what HTTP
      // status QBO returned.
      // direct_void: still requires an invoice to act on — no exception.
      if (item.resolution === "direct_void" && !item.qbo_invoice_id) {
        throw new Error(
          `Cannot direct_void — this is a "${item.item_type}" item with no existing QBO invoice. ` +
          `For ${item.item_type}, pick "Push to QBO" (creates a new invoice from the CRM job) or "Keep" / "Manual" instead.`
        );
      }
      // je_writeoff: invoice-less path supported when the item has a
      // customer name (the missing_invoice bulk JE flow). Block only when
      // BOTH invoice + customer name are missing — finalize has nothing
      // to credit. The detail branching for invoice-less je_writeoff
      // lives in the resolution handler below.
      if (
        item.resolution === "je_writeoff" &&
        !item.qbo_invoice_id &&
        !item.qbo_customer_name &&
        !item.uf_customer_name
      ) {
        throw new Error(
          `Cannot je_writeoff a "${item.item_type}" item with no QBO invoice AND no customer name — ` +
          `finalize has nothing to credit. Mark as "keep" or "manual" instead.`
        );
      }
      if (item.resolution === "apply_payment" && !item.uf_payment_id) {
        throw new Error(
          `Cannot apply_payment — item has no uf_payment_id. ` +
          `This usually means the discovery scan didn't capture a UF payment for this customer.`
        );
      }
      if (item.resolution === "push_invoice" && !item.matched_crm_job_id) {
        throw new Error(
          `Cannot push_invoice — item has no matched_crm_job_id. ` +
          `The discovery scan needs to link this item to a CRM job before SNAP can create the QBO invoice.`
        );
      }

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

        // Branch on whether the item references an existing QBO invoice
        // OR is a missing_invoice JE (Mike's bulk "write off revenue OR
        // bad debt" flow for jobs that completed in CRM but never made
        // it to QBO as an invoice).
        let jeBody: any;
        let amount: number;
        if (item.qbo_invoice_id) {
          // ─── Path A: classic duplicate-invoice write-off ─────────────
          // Pull the invoice's A/R account + customer for the credit line.
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

          amount = Number(item.qbo_invoice_balance ?? item.qbo_invoice_amount ?? 0);
          if (amount <= 0) {
            throw new Error("Invoice balance/amount is zero — nothing to write off");
          }

          jeBody = {
            TxnDate: postDate(item),
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
        } else {
          // ─── Path B: missing_invoice JE (no QBO invoice exists) ───────
          // The bookkeeper picked je_writeoff on a missing_invoice item
          // via Mike's "Bulk JE → write off revenue OR bad debt" flow.
          // Build the JE differently: we still credit A/R + Customer, but
          // we look the AR account up off the default Accounts Receivable
          // account in the COA (vs sourcing it from an invoice that
          // doesn't exist), and we look up the customer by name.
          const customerName = item.qbo_customer_name || item.uf_customer_name;
          if (!customerName) {
            throw new Error(
              `Cannot je_writeoff a ${item.item_type} item with no customer name`
            );
          }
          const customer = await findCustomerByName(
            (client as any).qbo_realm_id,
            accessToken,
            customerName
          );
          if (!customer) {
            throw new Error(
              `Customer "${customerName}" not found in QBO — can't post JE. ` +
              `Rename in CRM to match QBO, or pre-create the customer in QBO.`
            );
          }
          // Find the default A/R account. Most QBO files have exactly
          // one "Accounts Receivable" with AccountType="Accounts Receivable".
          const arAccount = allAccounts.find(
            (a) => a.AccountType === "Accounts Receivable" && a.Active !== false
          );
          if (!arAccount) {
            throw new Error(
              `No active Accounts Receivable account found in QBO — can't post the credit side of the JE.`
            );
          }
          // Amount source: missing_invoice items store the expected
          // amount in uf_payment_amount (per the start route — it's the
          // CRM job's amount we'd have invoiced).
          amount = Number(item.uf_payment_amount ?? item.qbo_invoice_amount ?? 0);
          if (amount <= 0) {
            throw new Error(
              `Missing-invoice item has no amount on file — can't post a $0 JE`
            );
          }

          jeBody = {
            TxnDate: postDate(item),
            PrivateNote:
              `Ironbooks Hardcore BS Cleanup (by ${bookkeeperName}) — ` +
              `JE for missing invoice on ${customerName} ` +
              `(no QBO invoice ever created; recorded revenue / wrote off via JE)`,
            Line: [
              {
                DetailType: "JournalEntryLineDetail",
                Amount: Number(amount.toFixed(2)),
                Description: `Missing-invoice JE: ${customerName}`,
                JournalEntryLineDetail: {
                  PostingType: "Debit",
                  AccountRef: { value: target.Id, name: target.Name },
                },
              },
              {
                DetailType: "JournalEntryLineDetail",
                Amount: Number(amount.toFixed(2)),
                Description: `A/R for missing invoice — ${customerName}`,
                JournalEntryLineDetail: {
                  PostingType: "Credit",
                  AccountRef: { value: arAccount.Id, name: arAccount.Name },
                  Entity: {
                    Type: "Customer",
                    EntityRef: { value: customer.id, name: customer.displayName },
                  },
                },
              },
            ],
          };
        }

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

      // push_invoice — V2: create a new QBO invoice for a completed CRM
      // job that has no matching invoice. Idempotency via PrivateNote token:
      // re-running finalize after a partial failure won't double-create.
      if (item.resolution === "push_invoice") {
        const customerName = item.qbo_customer_name || "";
        const amount = Number(item.uf_payment_amount || 0);
        if (!customerName) {
          throw new Error("push_invoice item has no customer name — cannot create invoice");
        }
        if (amount <= 0) {
          throw new Error(`push_invoice amount must be positive (got ${amount})`);
        }
        // Build idempotency token. Same item → same token → QBO check
        // returns the existing invoice on retry.
        const realmId = (client as any).qbo_realm_id as string;
        const idempotencyToken = `SNAP-CLEANUP-${runId}-${item.id}-INV`;
        const existingId = await findByPrivateNoteToken(
          realmId,
          accessToken,
          "Invoice",
          idempotencyToken
        );
        let invoiceId: string;
        let docNumber: string | null = null;
        if (existingId) {
          // Already created on a prior partial run — reuse.
          invoiceId = existingId;
        } else {
          // Resolve customer ID. findCustomerByName returns null if no
          // exact match — bookkeeper needs to either fix the customer
          // name in CRM or pre-create the customer in QBO before retry.
          const customer = await findCustomerByName(realmId, accessToken, customerName);
          if (!customer) {
            throw new Error(
              `Customer "${customerName}" not found in QBO. Create the customer first OR rename it in CRM to match QBO's spelling.`
            );
          }
          const created = await createInvoice(realmId, accessToken, {
            customerId: customer.id,
            customerName: customer.displayName,
            amount,
            description:
              item.reasoning ||
              `Invoice pushed from CRM by Ironbooks Hardcore Cleanup`,
            txnDate: postDate(item),
            docNumber: `SNAP-${runId.slice(0, 6)}-${item.id.slice(0, 4)}`,
            privateNote: `Ironbooks Hardcore Cleanup (${bookkeeperName}) — ${idempotencyToken}`,
          });
          invoiceId = created.Id;
          docNumber = created.DocNumber || null;
        }
        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            resolution_notes: `Pushed as QBO invoice ${invoiceId}${docNumber ? ` (#${docNumber})` : ""}`,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: "push_invoice",
          status: "ok",
          invoice_id: invoiceId,
          doc_number: docNumber,
          customer: customerName,
          amount,
          reused_existing: !!existingId,
        });
        continue;
      }

      // apply_payment — V2: sparse-update the UF Payment to link it to
      // open invoice(s) for the same customer. For 1:1 we find the single
      // matching invoice; for 1:N (bulk deposit), we find multiple
      // invoices summing to the payment amount using FIFO (oldest first).
      if (item.resolution === "apply_payment") {
        const ufPaymentId = item.uf_payment_id;
        const customerName = item.uf_customer_name || "";
        const amount = Number(item.uf_payment_amount || 0);
        if (!ufPaymentId) {
          throw new Error("apply_payment item has no uf_payment_id");
        }
        if (!customerName) {
          throw new Error("apply_payment item has no customer name");
        }
        const realmId = (client as any).qbo_realm_id as string;

        // Resolve customer + look up their open invoices
        const customer = await findCustomerByName(realmId, accessToken, customerName);
        if (!customer) {
          throw new Error(
            `Customer "${customerName}" not found in QBO — can't apply payment.`
          );
        }
        const openInvoices = await fetchOpenInvoicesForCustomer(
          realmId,
          accessToken,
          customer.id
        );
        if (openInvoices.length === 0) {
          throw new Error(
            `No open invoices for "${customerName}" — cannot apply payment. ` +
            `Either the invoices are already paid, or push_invoice items haven't been finalized yet.`
          );
        }

        // FIFO application: oldest-first, allocate until we cover the
        // payment amount. Allows partial allocation on the LAST invoice
        // so a $500 payment splits across a $300 + $200 invoice cleanly.
        const links: Array<{ invoiceId: string; amountApplied: number }> = [];
        let remaining = amount;
        for (const inv of openInvoices) {
          if (remaining <= 0.01) break;
          const applied = Math.min(remaining, inv.balance);
          if (applied > 0) {
            links.push({ invoiceId: inv.id, amountApplied: applied });
            remaining -= applied;
          }
        }
        if (links.length === 0 || remaining > 0.01) {
          throw new Error(
            `Couldn't fully allocate $${amount.toFixed(2)} payment — ` +
            `customer's open invoices sum to less than the payment amount ` +
            `(allocated $${(amount - remaining).toFixed(2)}, short by $${remaining.toFixed(2)}). ` +
            `Likely fix: push the missing_invoice items first, then re-run finalize.`
          );
        }

        const idempotencyToken = `SNAP-CLEANUP-${runId}-${item.id}-PMT`;
        const applied = await applyPaymentToInvoices(realmId, accessToken, {
          paymentId: ufPaymentId,
          invoiceLinks: links,
          privateNote: `Ironbooks Hardcore Cleanup (${bookkeeperName}) — ${idempotencyToken}`,
        });

        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            resolution_notes: `Applied $${amount.toFixed(2)} payment to ${links.length} invoice(s): ${links.map((l) => `${l.invoiceId}($${l.amountApplied.toFixed(2)})`).join(", ")}`,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: "apply_payment",
          status: "ok",
          payment_id: ufPaymentId,
          new_sync_token: applied.SyncToken,
          invoices_applied: links.length,
          links,
          customer: customerName,
          amount,
        });
        continue;
      }

      // recategorize — sparse-update the Deposit or JournalEntry whose
      // Line currently posts to Uncategorized Income, swapping that
      // Line's AccountRef.value to the bookkeeper-picked target. Used
      // for uncat_income items so the deposit moves from "Uncategorized
      // Income" to the real revenue account (Painting Revenue etc.)
      // without the bookkeeper opening QBO.
      //
      // Implementation notes:
      //   - We look up the txn by qbo_invoice_id (re-purposed at ingest
      //     time to hold the Deposit/JE id for uncat_income items).
      //   - QBO requires the FULL Line[] array on sparse update; we
      //     fetch the txn first to get the current SyncToken + Line[]
      //     shape, then rewrite only the matching Line(s).
      //   - Two txn types in scope: Deposit (Line[].DepositLineDetail.AccountRef)
      //     and JournalEntry (Line[].JournalEntryLineDetail.AccountRef).
      //   - We do NOT attempt to convert a Deposit into a Payment with
      //     LinkedTxn here — that's a separate "apply_payment" flow.
      //     recategorize ONLY moves the account; bookkeeper applies to
      //     an invoice via the apply_payment resolution if needed.
      if (item.resolution === "recategorize") {
        const target = accountById.get(item.resolution_target_account_id);
        if (!target) {
          throw new Error(
            `Target account ${item.resolution_target_account_id} not found in QBO. Pick another.`
          );
        }
        if (target.Active === false) {
          throw new Error(`Target account "${target.Name}" is inactive — pick another.`);
        }
        const txnId = item.qbo_invoice_id;
        if (!txnId) {
          throw new Error(
            `recategorize requires the source Deposit/JE id (item.qbo_invoice_id is null).`
          );
        }

        // Try Deposit first (most common for uncat_income items), then JE
        // as a fallback. We don't know which one ahead of time because
        // uncat_income items don't carry txn_type on the row.
        let txn: any = null;
        let txnType: "Deposit" | "JournalEntry" | null = null;
        try {
          const q1 = encodeURIComponent(`SELECT * FROM Deposit WHERE Id = '${txnId}'`);
          const r1: any = await qboCall(`/query?query=${q1}`, undefined, "GET");
          const d = r1?.QueryResponse?.Deposit?.[0];
          if (d) {
            txn = d;
            txnType = "Deposit";
          }
        } catch {
          // try JE below
        }
        if (!txn) {
          const q2 = encodeURIComponent(`SELECT * FROM JournalEntry WHERE Id = '${txnId}'`);
          const r2: any = await qboCall(`/query?query=${q2}`, undefined, "GET");
          const je = r2?.QueryResponse?.JournalEntry?.[0];
          if (je) {
            txn = je;
            txnType = "JournalEntry";
          }
        }
        if (!txn || !txnType) {
          throw new Error(
            `Could not find Deposit or JournalEntry with id ${txnId} in QBO (may have been deleted).`
          );
        }

        const detailKey =
          txnType === "Deposit" ? "DepositLineDetail" : "JournalEntryLineDetail";
        const lines: any[] = Array.isArray(txn.Line) ? txn.Line : [];
        if (lines.length === 0) {
          throw new Error(`${txnType} ${txnId} has no Line[] to update.`);
        }
        // Rewrite every line whose AccountRef points at the current
        // (Uncategorized Income) account. We don't have the source
        // account id on the item, so we identify by name fallback:
        // any Line whose AccountRef.name matches /uncategori[sz]ed/i
        // gets swapped. Conservative — if the bookkeeper has a vendor
        // also literally named "Uncategorized" they'd notice.
        let mutated = 0;
        const newLines = lines.map((ln) => {
          const detail = ln[detailKey] || {};
          const accRef = detail.AccountRef;
          if (!accRef) return ln;
          const isUncat = /uncategori[sz]ed/i.test(String(accRef.name || ""));
          if (!isUncat) return ln;
          mutated++;
          return {
            ...ln,
            [detailKey]: {
              ...detail,
              AccountRef: { value: target.Id, name: target.Name },
            },
          };
        });
        if (mutated === 0) {
          throw new Error(
            `No Uncategorized Income line found on ${txnType} ${txnId}. ` +
              `It may have already been recategorized — refresh + re-scan.`
          );
        }

        const updateBody: any = {
          Id: txn.Id,
          SyncToken: txn.SyncToken,
          sparse: true,
          Line: newLines,
          PrivateNote:
            (txn.PrivateNote || "") +
            (txn.PrivateNote ? "\n" : "") +
            `Ironbooks BS Cleanup (${bookkeeperName}): recategorized ` +
            `${mutated} line${mutated === 1 ? "" : "s"} from Uncategorized Income → "${target.Name}"`,
        };
        const endpoint =
          txnType === "Deposit"
            ? "/deposit?minorversion=70"
            : "/journalentry?minorversion=70";
        const updated: any = await qboCall(endpoint, updateBody);

        await service
          .from("hardcore_cleanup_items" as any)
          .update({
            resolution: "executed",
            resolved_at: new Date().toISOString(),
            resolution_notes:
              `Recategorized ${mutated} line(s) on ${txnType} ${txnId} ` +
              `from Uncategorized Income → ${target.Name}.`,
          } as any)
          .eq("id", item.id);
        executed++;
        results.push({
          id: item.id,
          type: "recategorize",
          status: "ok",
          txn_type: txnType,
          txn_id: txnId,
          lines_updated: mutated,
          new_account: target.Name,
          new_sync_token: updated?.[txnType]?.SyncToken,
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
