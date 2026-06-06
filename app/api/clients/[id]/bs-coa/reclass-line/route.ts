import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { reclassifyTransactionLines } from "@/lib/qbo-reclass";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/bs-coa/reclass-line
 *
 * Single-line reclassification — moves one QBO transaction line from
 * its current account to a target account. Used by the inline drawer
 * on /balance-sheet/[client_id]/coa for quick one-off cleanups (e.g.
 * "this $500 ended up in Undeposited Funds, move it to Customer Deposit").
 *
 * Body:
 *   {
 *     transaction_id: string,
 *     transaction_type: string,
 *     line_id: string,
 *     new_account_id: string,
 *     audit_note?: string,
 *   }
 *
 * The target_account_name is looked up server-side so the bookkeeper can't
 * accidentally pass a stale name. We also validate the target is a real
 * active account before writing — QBO would reject silently otherwise.
 *
 * Owner bookkeeper or admin/lead only.
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
    .select("id, qbo_realm_id, assigned_bookkeeper_id")
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

  const body = await request.json();
  const txId = String(body.transaction_id || "").trim();
  const txType = String(body.transaction_type || "").trim();
  const lineId = String(body.line_id || "").trim();
  const newAccountId = String(body.new_account_id || "").trim();
  const auditNote = body.audit_note ? String(body.audit_note).trim() : "";

  if (!txId || !txType || !lineId || !newAccountId) {
    return NextResponse.json(
      { error: "transaction_id, transaction_type, line_id, new_account_id are all required" },
      { status: 400 }
    );
  }

  let accessToken: string;
  let allAccounts;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const target = allAccounts.find((a) => a.Id === newAccountId);
  if (!target) {
    return NextResponse.json({ error: "Target account not found in QBO" }, { status: 404 });
  }
  if (target.Active === false) {
    return NextResponse.json(
      { error: `Target account "${target.Name}" is inactive — reactivate it first` },
      { status: 400 }
    );
  }

  const bookkeeperName = (actor as any)?.full_name || "bookkeeper";
  const memo = `Ironbooks BS inline reclass by ${bookkeeperName}${auditNote ? ` — ${auditNote}` : ""}`;

  try {
    await reclassifyTransactionLines(
      (client as any).qbo_realm_id,
      accessToken,
      {
        txType: txType as any,
        txId,
        lineUpdates: [
          {
            line_id: lineId,
            new_account_id: newAccountId,
            new_account_name: target.Name,
          },
        ],
        auditMemo: memo,
      }
    );
    return NextResponse.json({
      ok: true,
      moved_to: { id: target.Id, name: target.Name },
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
