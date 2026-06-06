import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getValidToken, qboErrorResponse } from "@/lib/qbo";
import {
  listBalanceSheetAccounts,
  fetchBalancesAsOf,
} from "@/lib/qbo-balance-sheet";
import {
  suggestJE,
  type AccountCategory,
  type JESuggestion,
} from "@/lib/bs-je-suggester";

export const dynamic = "force-dynamic";

interface BatchEntry {
  qbo_account_id: string;
  category: AccountCategory | null;
  statement_ending_balance: number | null;
  statement_as_of_date: string | null;
  notes?: string | null;
}

/**
 * POST /api/balance-sheet/bank-recon-batch
 *
 * Single-call save for the inline BS Cleanup form. The bookkeeper has
 * categorized each account + entered (some or all) statement ending
 * balances on the same screen. We:
 *
 *   1. Upsert client_account_categories for every entry with a non-null
 *      category (sticky across cleanup cycles).
 *   2. Insert a bank_recon_jobs row for every entry with a statement
 *      balance + date.
 *   3. Run suggestJE() on each entry and return the suggestion array
 *      so the UI can render gaps + adjusting-JE proposals inline
 *      without a page reload.
 *
 * Body:
 *   { client_link_id: string, entries: BatchEntry[] }
 *
 * Returns:
 *   { ok: true, suggestions: Array<{ qbo_account_id, ...JESuggestion }> }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId: string = body?.client_link_id;
  const entries: BatchEntry[] = Array.isArray(body?.entries) ? body.entries : [];
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Pull live accounts from QBO for current_balance + name + last4.
  // One QBO fetch covers the whole batch.
  let liveAccounts;
  let asOfBalancesByDate = new Map<string, Map<string, number>>();
  try {
    const accessToken = await getValidToken(clientLinkId, service as any);
    liveAccounts = await listBalanceSheetAccounts(
      (client as any).qbo_realm_id,
      accessToken
    );

    // ── Per-date "balance as of" fetch ──
    // The QBO `CurrentBalance` on the Account is the ledger balance
    // RIGHT NOW. For reconciliation against a month-old statement, we
    // need the QBO balance AS OF the statement date — otherwise the
    // gap includes a month of uncleared activity and looks scary even
    // when the books are fine. One BalanceSheet report call per unique
    // statement_as_of_date in the batch (most batches use the same date).
    const uniqueDates = new Set<string>();
    for (const e of entries) {
      if (e.statement_as_of_date) uniqueDates.add(e.statement_as_of_date);
    }
    if (uniqueDates.size > 0) {
      const results = await Promise.all(
        Array.from(uniqueDates).map(async (d) => ({
          date: d,
          balances: await fetchBalancesAsOf(
            (client as any).qbo_realm_id,
            accessToken,
            d
          ),
        }))
      );
      for (const r of results) {
        asOfBalancesByDate.set(r.date, r.balances);
      }
    }
  } catch (err: any) {
    return qboErrorResponse(err);
  }
  const byId = new Map(liveAccounts.map((a) => [a.qbo_account_id, a]));

  const suggestions: Array<JESuggestion & { qbo_account_id: string; account_name: string }> = [];
  const categoryUpserts: any[] = [];
  const reconInserts: any[] = [];

  for (const entry of entries) {
    const acc = byId.get(entry.qbo_account_id);
    if (!acc) continue; // skip entries whose account vanished from QBO

    // 1. Category upsert
    if (entry.category) {
      categoryUpserts.push({
        client_link_id: clientLinkId,
        qbo_account_id: entry.qbo_account_id,
        category: entry.category,
        qbo_account_name: acc.name,
        qbo_account_last4: acc.last4,
        set_by: user.id,
        updated_at: new Date().toISOString(),
      });
    }

    // Use AS-OF balance when we have one for the statement date.
    // Fall back to current_balance only when no date is set OR the
    // BalanceSheet report failed (zero balance accounts get dropped
    // from the report — those default to 0 here).
    const asOfMap = entry.statement_as_of_date
      ? asOfBalancesByDate.get(entry.statement_as_of_date)
      : null;
    const qboBalanceAtDate =
      entry.statement_as_of_date && asOfMap
        ? asOfMap.get(entry.qbo_account_id) ?? 0
        : Number(acc.current_balance);

    // 2. Recon insert — only when both balance + date are present
    let gap = 0;
    if (
      entry.statement_ending_balance != null &&
      entry.statement_as_of_date
    ) {
      gap = Number(entry.statement_ending_balance) - qboBalanceAtDate;
      reconInserts.push({
        client_link_id: clientLinkId,
        bookkeeper_id: user.id,
        qbo_account_id: entry.qbo_account_id,
        qbo_account_name: acc.name,
        qbo_account_type: acc.account_type,
        qbo_account_last4: acc.last4,
        category: entry.category || null,
        statement_ending_balance: Number(entry.statement_ending_balance),
        statement_as_of_date: entry.statement_as_of_date,
        qbo_balance_at_date: qboBalanceAtDate,
        gap_amount: gap,
        status: "created",
        notes: entry.notes || null,
      });
    }

    // 3. JE suggestion — use the AS-OF balance so the gap math matches
    //    what the bookkeeper sees in QBO if they pull a BS report at
    //    the same date.
    const sug = suggestJE({
      category: entry.category || null,
      account_name: acc.name,
      qbo_balance: qboBalanceAtDate,
      statement_balance: entry.statement_ending_balance ?? null,
      statement_date: entry.statement_as_of_date ?? null,
    });
    suggestions.push({
      ...sug,
      qbo_account_id: entry.qbo_account_id,
      account_name: acc.name,
      qbo_balance_at_date: qboBalanceAtDate,
      qbo_current_balance: Number(acc.current_balance),
    } as any);
  }

  // Persist categories (upsert by composite unique).
  if (categoryUpserts.length > 0) {
    const { error: catErr } = await (service as any)
      .from("client_account_categories")
      .upsert(categoryUpserts, {
        onConflict: "client_link_id,qbo_account_id",
      });
    if (catErr) {
      return NextResponse.json(
        { error: `Category save failed: ${catErr.message}` },
        { status: 500 }
      );
    }
  }

  // Persist recon entries (each save is a new row — history-preserving).
  if (reconInserts.length > 0) {
    const { error: reconErr } = await (service as any)
      .from("bank_recon_jobs")
      .insert(reconInserts);
    if (reconErr) {
      return NextResponse.json(
        { error: `Recon save failed: ${reconErr.message}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    saved_categories: categoryUpserts.length,
    saved_recons: reconInserts.length,
    suggestions,
  });
}

/**
 * GET /api/balance-sheet/bank-recon-batch?client_link_id=...
 *
 * Pre-fills the inline form: returns the bookkeeper's most-recent
 * categorization for each account + their most-recent recon entry
 * (statement balance + date), so opening the BS page again doesn't
 * lose prior input.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const clientLinkId = url.searchParams.get("client_link_id");
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  const { data: cats } = await (service as any)
    .from("client_account_categories")
    .select("qbo_account_id, category")
    .eq("client_link_id", clientLinkId);

  // Most-recent recon entry per account
  const { data: recons } = await (service as any)
    .from("bank_recon_jobs")
    .select(
      "qbo_account_id, statement_ending_balance, statement_as_of_date, notes, created_at"
    )
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false });

  const latestRecon = new Map<string, any>();
  for (const r of (recons as any[]) || []) {
    if (!latestRecon.has(r.qbo_account_id)) latestRecon.set(r.qbo_account_id, r);
  }
  const categoryMap = new Map<string, string>();
  for (const c of (cats as any[]) || []) {
    categoryMap.set(c.qbo_account_id, c.category);
  }

  return NextResponse.json({
    ok: true,
    prefill: Object.fromEntries(
      [...new Set([...categoryMap.keys(), ...latestRecon.keys()])].map((id) => [
        id,
        {
          category: categoryMap.get(id) || null,
          statement_ending_balance:
            latestRecon.get(id)?.statement_ending_balance ?? null,
          statement_as_of_date:
            latestRecon.get(id)?.statement_as_of_date ?? null,
          notes: latestRecon.get(id)?.notes ?? null,
        },
      ])
    ),
  });
}
