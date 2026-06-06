import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { fetchTransactionsForAccount, getValidToken } from "@/lib/qbo-reclass";
import { qboErrorResponse } from "@/lib/qbo";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/bs-coa/transactions/[accountId]?days=90&limit=200
 *
 * Returns line-level transactions hitting the given BS account in the
 * past N days (default 90). Returns the same ReclassLine shape used by
 * the reclass flow — line_id + sync_token included so the inline
 * "Move to..." action can target the exact line via reclassifyTransactionLines.
 *
 * Used by the BS COA drawer on /balance-sheet/[client_id]/coa.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; accountId: string }> }
) {
  const { id: clientLinkId, accountId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(730, parseInt(url.searchParams.get("days") || "90", 10)));
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "200", 10)));

  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const startYmd = start.toISOString().slice(0, 10);
  const endYmd = end.toISOString().slice(0, 10);

  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    const { lines, transactionsPulled } = await fetchTransactionsForAccount(
      (client as any).qbo_realm_id,
      accessToken,
      accountId,
      startYmd,
      endYmd
    );

    // Sort newest first, cap to limit. The bookkeeper's drawer can paginate
    // later if we need it; 200 covers typical 90-day windows.
    const sorted = [...lines].sort((a, b) =>
      b.transaction_date.localeCompare(a.transaction_date)
    );
    const trimmed = sorted.slice(0, limit);

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      window: { start: startYmd, end: endYmd, days },
      transactions_pulled: transactionsPulled,
      lines_total: lines.length,
      lines_returned: trimmed.length,
      lines: trimmed.map((l) => ({
        transaction_id: l.transaction_id,
        transaction_type: l.transaction_type,
        line_id: l.line_id,
        sync_token: l.sync_token,
        transaction_date: l.transaction_date,
        transaction_amount: l.transaction_amount,
        vendor_name: l.vendor_name,
        description: l.description,
        private_note: l.private_note,
        is_reconciled: l.is_reconciled,
        is_bank_fed: l.is_bank_fed,
        is_manual_entry: l.is_manual_entry,
      })),
    });
  } catch (err: any) {
    return qboErrorResponse(err);
  }
}
