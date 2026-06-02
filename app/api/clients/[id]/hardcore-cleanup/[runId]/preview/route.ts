import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/clients/[id]/hardcore-cleanup/[runId]/preview
 *
 * Given the current item resolutions for a run, return the exact list of
 * QBO operations finalize WOULD execute — without actually writing anything.
 * Powers the preview-before-push modal that satisfies Mike's hard
 * requirement: "bookkeeper sees changes before they're made."
 *
 * Response shape:
 *   {
 *     ops:      [{ item_id, kind, summary, body, warnings }],
 *     blockers: [{ item_id, reason }],   // items that can't be processed
 *     summary:  { je_count, void_count, push_invoice_count, apply_payment_count,
 *                 ask_client_count, manual_count }
 *   }
 *
 * V1 caveat: push_invoice and apply_payment ship as "manual handoff"
 * placeholders — preview shows the proposed payload, finalize exports
 * a CSV of them for Lisa to action manually in QBO. V2 (#73) wires up
 * the real createInvoice + applyPayment QBO calls.
 */
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
    .select("id, assigned_bookkeeper_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

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

  const { data: run } = await service
    .from("hardcore_cleanup_runs" as any)
    .select("*")
    .eq("id", runId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Same filter as finalize — resolved items that haven't already been
  // executed / failed. If finalize and preview ever diverge here we'd be
  // showing the bookkeeper a different op set than what would run.
  const { data: items } = await service
    .from("hardcore_cleanup_items" as any)
    .select("*")
    .eq("run_id", runId)
    .neq("resolution", "pending")
    .neq("resolution", "executed")
    .neq("resolution", "failed")
    .neq("resolution", "skipped");

  const queue = (items as any[]) || [];

  const ops: Array<{
    item_id: string;
    kind: string;
    summary: string;
    body: any;
    warnings: string[];
  }> = [];
  const blockers: Array<{ item_id: string; reason: string }> = [];

  const summary = {
    je_count: 0,
    void_count: 0,
    push_invoice_count: 0,
    apply_payment_count: 0,
    ask_client_count: 0,
    manual_count: 0,
    keep_count: 0,
  };

  for (const item of queue) {
    const warnings: string[] = [];

    switch (item.resolution) {
      case "je_writeoff": {
        if (!item.resolution_target_account_id) {
          blockers.push({
            item_id: item.id,
            reason: "JE write-off picked but no target account selected. Pick an account before pushing.",
          });
          continue;
        }
        if (!item.qbo_invoice_id) {
          blockers.push({
            item_id: item.id,
            reason: "Item has no QBO invoice to write off. Re-scan if this is unexpected.",
          });
          continue;
        }
        const amount = Number(item.qbo_invoice_balance ?? item.qbo_invoice_amount ?? 0);
        if (amount <= 0) {
          warnings.push(`Invoice balance is ${amount} — JE will be $0`);
        }
        summary.je_count++;
        ops.push({
          item_id: item.id,
          kind: "je_writeoff",
          summary: `JE: Dr ${item.resolution_target_account_name} $${amount.toFixed(2)}, Cr A/R (${item.qbo_customer_name || "no customer"}) — invoice #${item.qbo_invoice_doc_number || item.qbo_invoice_id}`,
          body: {
            TxnDate: new Date().toISOString().slice(0, 10),
            DocNumber: `SNAP-${runId.slice(0, 8)}-${item.id.slice(0, 4)}`,
            PrivateNote: `Ironbooks Hardcore Cleanup — write off duplicate invoice #${item.qbo_invoice_doc_number || item.qbo_invoice_id} for ${item.qbo_customer_name || "(no customer)"}`,
            Line: [
              {
                Amount: amount,
                DetailType: "JournalEntryLineDetail",
                JournalEntryLineDetail: {
                  PostingType: "Debit",
                  AccountRef: {
                    value: item.resolution_target_account_id,
                    name: item.resolution_target_account_name,
                  },
                },
              },
              {
                Amount: amount,
                DetailType: "JournalEntryLineDetail",
                JournalEntryLineDetail: {
                  PostingType: "Credit",
                  AccountRef: { value: "(A/R lookup at finalize)" },
                  Entity: {
                    Type: "Customer",
                    EntityRef: {
                      value: item.qbo_customer_id || "(lookup at finalize)",
                      name: item.qbo_customer_name,
                    },
                  },
                },
              },
            ],
          },
          warnings,
        });
        break;
      }

      case "direct_void": {
        if (!item.qbo_invoice_id) {
          blockers.push({
            item_id: item.id,
            reason: "Direct void picked but no QBO invoice to void.",
          });
          continue;
        }
        summary.void_count++;
        ops.push({
          item_id: item.id,
          kind: "direct_void",
          summary: `Void invoice #${item.qbo_invoice_doc_number || item.qbo_invoice_id} for ${item.qbo_customer_name || "(no customer)"} — zeroes balance + amount`,
          body: {
            method: "POST",
            url: `/invoice?operation=void`,
            payload: { Id: item.qbo_invoice_id, SyncToken: "(fetched at finalize)" },
          },
          warnings,
        });
        break;
      }

      case "push_invoice": {
        // V1: manual handoff. V2 will replace the body with a real
        // QBO createInvoice payload.
        summary.push_invoice_count++;
        const amount = Number(item.uf_payment_amount ?? 0);
        ops.push({
          item_id: item.id,
          kind: "push_invoice",
          summary: `[MANUAL HANDOFF — V1] Push invoice for ${item.qbo_customer_name || "(no customer)"} — $${amount.toFixed(2)}. CSV will be exported.`,
          body: {
            v2_payload_preview: {
              CustomerRef: { value: "(lookup by name)", name: item.qbo_customer_name },
              Line: [
                {
                  Amount: amount,
                  DetailType: "SalesItemLineDetail",
                  Description: item.reasoning || "Pushed from CRM",
                },
              ],
            },
            note: "V1 ships this as a CSV export. V2 (#73) sends to QBO via /invoice.",
          },
          warnings: ["V1: manual handoff — Lisa creates this invoice in QBO from the CSV"],
        });
        break;
      }

      case "apply_payment": {
        // V1: manual handoff. V2 will replace with a real applyPayment.
        summary.apply_payment_count++;
        const amount = Number(item.uf_payment_amount ?? 0);
        const jobCount = Array.isArray(item.crm_job_ids) ? item.crm_job_ids.length : 1;
        ops.push({
          item_id: item.id,
          kind: "apply_payment",
          summary: `[MANUAL HANDOFF — V1] Apply UF payment $${amount.toFixed(2)} from ${item.uf_customer_name || "(no customer)"} to ${jobCount} CRM job${jobCount === 1 ? "" : "s"}. CSV will be exported.`,
          body: {
            v2_payload_preview: {
              PaymentId: item.uf_payment_id,
              LinkedTxn: { count: jobCount, note: "Invoice IDs resolved at finalize" },
            },
            note: "V1 ships this as a CSV export. V2 (#73) sends sparse update to /payment/<id>.",
          },
          warnings: ["V1: manual handoff — Lisa applies this payment in QBO from the CSV"],
        });
        break;
      }

      case "ask_client": {
        summary.ask_client_count++;
        ops.push({
          item_id: item.id,
          kind: "ask_client",
          summary: `Generate "ask the client" email for ${item.uf_customer_name || "(no customer)"} — $${Number(item.uf_payment_amount ?? 0).toFixed(2)} deposit on ${item.uf_payment_date}`,
          body: {
            kind: "email_draft",
            customer: item.uf_customer_name,
            amount: item.uf_payment_amount,
            date: item.uf_payment_date,
            memo: item.qbo_invoice_memo,
          },
          warnings,
        });
        break;
      }

      case "keep":
      case "manual": {
        summary.keep_count++;
        ops.push({
          item_id: item.id,
          kind: item.resolution,
          summary: `No QBO write — marked '${item.resolution}'`,
          body: null,
          warnings,
        });
        summary.manual_count = item.resolution === "manual" ? summary.manual_count + 1 : summary.manual_count;
        break;
      }

      default:
        blockers.push({
          item_id: item.id,
          reason: `Unknown resolution '${item.resolution}' — preview can't generate a body.`,
        });
    }
  }

  return NextResponse.json({
    ok: true,
    run_id: runId,
    workflow_version: (run as any).workflow_version,
    total_resolved: queue.length,
    ops,
    blockers,
    summary,
  });
}
