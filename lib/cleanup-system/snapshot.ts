/**
 * QBO snapshot pull — trial balance + balance sheet accounts at run start.
 */

import { getValidToken } from "@/lib/qbo";
import { listBalanceSheetAccounts } from "@/lib/qbo-balance-sheet";
import { withQboThrottle } from "./qbo-queue";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SnapshotResult {
  snapshotId: string;
  trialBalance: Array<{
    qbo_account_id: string;
    name: string;
    account_type: string;
    balance: number;
  }>;
  balanceSheet: Array<{
    qbo_account_id: string;
    name: string;
    account_type: string;
    balance: number;
    kind: string;
  }>;
  accountBalances: Record<string, number>;
}

export async function pullQboSnapshot(
  service: SupabaseClient,
  clientLinkId: string,
  asOfDate: string,
  createdBy: string
): Promise<SnapshotResult> {
  const { data: client } = await service
    .from("client_links")
    .select("qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) throw new Error("Client not found");

  const accessToken = await getValidToken(clientLinkId, service);
  const realmId = (client as any).qbo_realm_id;

  const bsAccounts = await withQboThrottle(realmId, () =>
    listBalanceSheetAccounts(realmId, accessToken)
  );

  // Pull all accounts for trial balance
  const query = encodeURIComponent("SELECT * FROM Account WHERE Active = true MAXRESULTS 1000");
  const data: any = await withQboThrottle(realmId, async () => {
    const res = await fetch(
      `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${query}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`QBO account query failed: ${res.status}`);
    return res.json();
  });

  const allAccounts: any[] = data?.QueryResponse?.Account || [];
  const accountBalances: Record<string, number> = {};

  const trialBalance = allAccounts.map((a) => {
    const balance = Number(a.CurrentBalance || 0);
    accountBalances[a.Id] = balance;
    return {
      qbo_account_id: a.Id,
      name: a.Name,
      account_type: a.AccountType,
      balance,
    };
  });

  const balanceSheet = bsAccounts.map((a) => ({
    qbo_account_id: a.qbo_account_id,
    name: a.name,
    account_type: a.account_type,
    balance: a.current_balance,
    kind: a.kind,
  }));

  const { data: snapshot, error } = await service
    .from("qbo_snapshots")
    .insert({
      client_link_id: clientLinkId,
      as_of_date: asOfDate,
      trial_balance: trialBalance,
      balance_sheet: balanceSheet,
      account_balances: accountBalances,
      created_by: createdBy,
    } as any)
    .select("id")
    .single();

  if (error) throw new Error(`Failed to save snapshot: ${error.message}`);

  return {
    snapshotId: snapshot.id,
    trialBalance,
    balanceSheet,
    accountBalances,
  };
}
