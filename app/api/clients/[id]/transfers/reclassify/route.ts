import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { reclassifyTransfer } from "@/lib/qbo-transfers";

/**
 * POST /api/clients/[id]/transfers/reclassify
 *   {
 *     transfer_id: string,
 *     new_from_account_id?: string,      // omit to leave From unchanged
 *     new_to_account_id?: string,        // omit to leave To unchanged
 *     expected_from_account_id?: string, // stale guard (optional)
 *     expected_to_account_id?: string,   // stale guard (optional)
 *     dry_run?: boolean                  // default TRUE — must pass false to write
 *   }
 *
 * Re-points one QBO `Transfer`'s From/To account. dry_run defaults TRUE:
 * refetch + plan, no write. Account NAMES are resolved server-side from the
 * live chart so QBO stores the readable label. Owner bookkeeper or admin/lead.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    .select("id, client_name, qbo_realm_id, is_active, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client is inactive or has no QBO connection" }, { status: 400 });
  }

  const { data: actor } = await service.from("users").select("role, full_name").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({} as any));
  const transferId = String(body.transfer_id || "").trim();
  if (!transferId) return NextResponse.json({ error: "transfer_id required" }, { status: 400 });
  const newFromId = body.new_from_account_id ? String(body.new_from_account_id) : null;
  const newToId = body.new_to_account_id ? String(body.new_to_account_id) : null;
  if (!newFromId && !newToId) {
    return NextResponse.json({ error: "Provide new_from_account_id and/or new_to_account_id" }, { status: 400 });
  }
  const dryRun = body.dry_run !== false; // default TRUE

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);

    // Resolve readable names for whichever side is changing.
    const nameById = new Map<string, string>();
    if (newFromId || newToId) {
      const accounts = await fetchAllAccounts(realm, token);
      for (const a of accounts) nameById.set(String(a.Id), a.FullyQualifiedName || a.Name);
    }

    const result = await reclassifyTransfer(realm, token, {
      transferId,
      newFromAccountId: newFromId,
      newFromAccountName: newFromId ? nameById.get(newFromId) ?? null : null,
      newToAccountId: newToId,
      newToAccountName: newToId ? nameById.get(newToId) ?? null : null,
      expectedFromAccountId: body.expected_from_account_id != null ? String(body.expected_from_account_id) : null,
      expectedToAccountId: body.expected_to_account_id != null ? String(body.expected_to_account_id) : null,
      auditMemo: `SNAP transfer reclass by ${(actor as any)?.full_name || "bookkeeper"}`,
      dryRun,
    });

    if (!dryRun && result.action === "apply") {
      await service.from("audit_log").insert({
        event_type: "transfer_reclass",
        user_id: user.id,
        request_payload: {
          client_link_id: clientLinkId,
          client_name: (client as any).client_name,
          transfer_id: transferId,
          from_account_id: result.from_account_id,
          to_account_id: result.to_account_id,
          ok: result.ok,
        } as any,
      } as any);
    }

    return NextResponse.json({ dry_run: dryRun, ...result });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
