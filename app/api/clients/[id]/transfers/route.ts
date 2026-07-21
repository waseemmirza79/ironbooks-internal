import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { fetchTransfers } from "@/lib/qbo-transfers";

/**
 * GET /api/clients/[id]/transfers?start=&end=   (READ-ONLY)
 *
 * Lists the client's QBO `Transfer` entities in a date range — the between-
 * account moves (e.g. bank-feed "Online Banking Transfer") that the expense
 * reclass pipeline never sees (it only queries Bill/Purchase/Expense/
 * VendorCredit). Also returns the active balance-sheet accounts a transfer
 * can point at, for the From/To picker.
 *
 * Owner bookkeeper or admin/lead only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Transfers move money between balance-sheet accounts — surface those as the
// picker options (bank, credit card, other asset/liability, equity).
const TRANSFER_ELIGIBLE_TYPES = new Set([
  "Bank",
  "Credit Card",
  "Other Current Asset",
  "Other Current Liability",
  "Long Term Liability",
  "Fixed Asset",
  "Other Asset",
  "Equity",
]);

export async function GET(
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
    .select("id, qbo_realm_id, is_active, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!(client as any).qbo_realm_id || !(client as any).is_active) {
    return NextResponse.json({ error: "Client is inactive or has no QBO connection" }, { status: 400 });
  }

  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const year = new Date().getFullYear();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("start") || "") ? url.searchParams.get("start")! : `${year}-01-01`;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("end") || "") ? url.searchParams.get("end")! : new Date().toISOString().slice(0, 10);

  try {
    const realm = (client as any).qbo_realm_id as string;
    const token = await getValidToken(clientLinkId, service as any);
    const [{ transfers, pulled }, accounts] = await Promise.all([
      fetchTransfers(realm, token, start, end),
      fetchAllAccounts(realm, token),
    ]);
    const options = accounts
      .filter((a) => a.Active !== false && TRANSFER_ELIGIBLE_TYPES.has(String(a.AccountType || "")))
      .map((a) => ({ id: String(a.Id), name: a.FullyQualifiedName || a.Name, type: a.AccountType }))
      .sort((x, y) => x.name.localeCompare(y.name));

    return NextResponse.json({
      client_link_id: clientLinkId,
      window: { start, end },
      count: transfers.length,
      pulled,
      transfers,
      account_options: options,
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
