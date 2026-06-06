import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { createAccount, getValidToken, qboErrorResponse } from "@/lib/qbo";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/bs-coa/account
 *
 * Create a new Balance Sheet account in the client's QBO.
 *
 * Body:
 *   {
 *     name: string,
 *     account_type: string,         // QBO enum: "Bank", "Other Current Asset", etc
 *     account_subtype: string,      // QBO subtype enum (e.g., "Checking", "OwnersEquity")
 *     parent_id?: string,           // optional — makes it a sub-account
 *     description?: string,
 *   }
 *
 * Validates the type is in the BS_ACCOUNT_TYPE_NAMES allowlist so the bookkeeper
 * can't accidentally create a P&L-type account via this endpoint (use the COA
 * cleanup wizard for P&L instead).
 *
 * Owner bookkeeper or admin/lead only.
 */

const BS_ACCOUNT_TYPE_NAMES = new Set([
  "Bank",
  "Accounts Receivable",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Accounts Payable",
  "Credit Card",
  "Other Current Liability",
  "Long Term Liability",
  "Equity",
]);

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
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const name = String(body.name || "").trim();
  const accountType = String(body.account_type || "").trim();
  const accountSubType = String(body.account_subtype || "").trim();
  const parentRefId = body.parent_id ? String(body.parent_id).trim() : undefined;
  const description = body.description ? String(body.description).trim() : undefined;

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!BS_ACCOUNT_TYPE_NAMES.has(accountType)) {
    return NextResponse.json(
      {
        error: `account_type "${accountType}" is not a Balance Sheet type — expected one of: ${[...BS_ACCOUNT_TYPE_NAMES].join(", ")}`,
      },
      { status: 400 }
    );
  }
  if (!accountSubType) {
    return NextResponse.json({ error: "account_subtype is required" }, { status: 400 });
  }

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const created = await createAccount((client as any).qbo_realm_id, accessToken, {
      name,
      accountType,
      accountSubType,
      parentRefId,
      description,
    });
    return NextResponse.json({
      ok: true,
      account: {
        id: created.Id,
        name: created.Name,
        account_type: created.AccountType,
        account_subtype: created.AccountSubType,
      },
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
