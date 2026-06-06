import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/bs-coa
 *
 * Returns EVERY active Balance Sheet account on the client's QBO COA —
 * bank, credit card, A/R, A/P, fixed assets, other assets, all liability
 * subtypes, equity. Includes parent/child hierarchy + current balance.
 *
 * Drives the standalone BS COA viewer at /balance-sheet/[client_id]/coa.
 * Distinct from /bs-accounts which returns only the bank/cc/loan subset
 * used by the workflow's Step 5 reconciliation form.
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

interface BsCoaAccount {
  id: string;
  name: string;
  fully_qualified_name: string;
  account_type: string;
  account_subtype: string | null;
  parent_id: string | null;
  parent_name: string | null;
  is_sub_account: boolean;
  current_balance: number;
  currency: string | null;
  active: boolean;
  depth: number;
  children: BsCoaAccount[];
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let allAccounts: any[];
  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    allAccounts = await fetchAllAccounts((client as any).qbo_realm_id, accessToken);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  // Filter to BS account types, keep both active + inactive (UI can toggle)
  const bsAccounts = allAccounts.filter((a) =>
    BS_ACCOUNT_TYPE_NAMES.has(a.AccountType)
  );

  // Build a flat list first so we can compute hierarchy
  const flat: BsCoaAccount[] = bsAccounts.map((a) => ({
    id: a.Id,
    name: a.Name,
    fully_qualified_name: a.FullyQualifiedName || a.Name,
    account_type: a.AccountType,
    account_subtype: a.AccountSubType || null,
    parent_id: a.ParentRef?.value || null,
    parent_name: a.ParentRef?.name || null,
    is_sub_account: !!a.SubAccount,
    current_balance: Number(a.CurrentBalance || 0),
    currency: a.CurrencyRef?.value || null,
    active: a.Active !== false,
    depth: 0,
    children: [],
  }));

  // Build parent → children map. Note: a sub-account may reference a parent
  // that's been excluded (e.g., a P&L parent or a deleted parent). In that
  // case we treat it as a root for display.
  const byId = new Map(flat.map((a) => [a.id, a]));
  const roots: BsCoaAccount[] = [];
  for (const acc of flat) {
    if (acc.parent_id && byId.has(acc.parent_id)) {
      byId.get(acc.parent_id)!.children.push(acc);
    } else {
      roots.push(acc);
    }
  }

  // Assign depth (recursive)
  function assignDepth(node: BsCoaAccount, d: number) {
    node.depth = d;
    for (const child of node.children) assignDepth(child, d + 1);
  }
  for (const r of roots) assignDepth(r, 0);

  // Sort: by account_type group order, then by name within each level
  const TYPE_ORDER = [
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
  ];
  function sortChildren(node: BsCoaAccount) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of node.children) sortChildren(c);
  }
  roots.sort((a, b) => {
    const ai = TYPE_ORDER.indexOf(a.account_type);
    const bi = TYPE_ORDER.indexOf(b.account_type);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
  for (const r of roots) sortChildren(r);

  // Group roots by account_type for the UI's section headers
  const groups: Array<{
    account_type: string;
    accounts: BsCoaAccount[];
    total_balance: number;
  }> = [];
  for (const type of TYPE_ORDER) {
    const inType = roots.filter((r) => r.account_type === type);
    if (inType.length === 0) continue;
    // Sum balances including children
    const sumWithChildren = (n: BsCoaAccount): number =>
      n.current_balance + n.children.reduce((s, c) => s + sumWithChildren(c), 0);
    const total = inType.reduce((s, r) => s + sumWithChildren(r), 0);
    groups.push({ account_type: type, accounts: inType, total_balance: total });
  }

  return NextResponse.json({
    ok: true,
    client_name: (client as any).client_name,
    total_accounts: flat.length,
    active_accounts: flat.filter((a) => a.active).length,
    groups,
  });
}
