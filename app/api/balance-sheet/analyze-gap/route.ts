import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import { fetchAccountTransactions } from "@/lib/qbo-balance-sheet";
import { analyzeGap } from "@/lib/bs-gap-analyzer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/balance-sheet/analyze-gap
 *
 * Given a reconciliation gap (QBO ledger ≠ statement at a date),
 * pull every transaction hitting the account over a window and run
 * heuristic gap analysis to surface the most-likely culprits
 * (duplicates, gap-amount matches, uncleared items, round-number
 * plugs, statistical outliers).
 *
 * Body:
 *   {
 *     client_link_id: string
 *     qbo_account_id: string
 *     statement_as_of_date: string  // YYYY-MM-DD; we look 90d before this
 *     gap_amount: number
 *     window_start?: string         // optional override (default: 90d back)
 *     window_end?: string           // optional override (default: as-of date)
 *   }
 *
 * Returns the analyzeGap output + the raw transactions for the UI to
 * render a sortable table.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const {
    client_link_id,
    qbo_account_id,
    statement_as_of_date,
    gap_amount,
    window_start,
    window_end,
  } = body || {};
  if (!client_link_id || !qbo_account_id || !statement_as_of_date) {
    return NextResponse.json(
      {
        error:
          "Body must include client_link_id, qbo_account_id, statement_as_of_date.",
      },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", client_link_id)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Default window: 90 days back from the statement date.
  const endDate = window_end || statement_as_of_date;
  const start =
    window_start ||
    new Date(
      new Date(statement_as_of_date).getTime() - 90 * 86400000
    )
      .toISOString()
      .slice(0, 10);

  let transactions;
  try {
    const accessToken = await getValidToken(client_link_id, service as any);
    transactions = await fetchAccountTransactions(
      (client as any).qbo_realm_id,
      accessToken,
      qbo_account_id,
      start,
      endDate
    );
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  const analysis = analyzeGap(transactions, Number(gap_amount || 0));

  return NextResponse.json({
    ok: true,
    window: { start, end: endDate },
    transactions,
    analysis,
  });
}
