/**
 * Reclassify a P&L account's balance onto another account via journal entries.
 *
 * QBO's API cannot MERGE accounts (renaming to an existing name returns a
 * duplicate-name error — the UI merge isn't exposed), and it cannot move
 * invoice/sales-receipt revenue by line (income comes from the Item's
 * IncomeAccountRef, not the line). The accountant-standard way to consolidate
 * an income/expense/COGS account into another — or to move a wrongly-typed
 * account's balance into a correctly-typed one — is a reclassifying journal
 * entry: one JE per month over the range, dated month-end, so monthly
 * (cash-basis) statements stay correct.
 *
 * Direction: drain the source in the OPPOSITE of its normal balance and add to
 * the target in the source's normal direction (income/equity are credit-normal,
 * expense/other-expense/COGS are debit-normal). A negative month (contra/refund)
 * flips both. Caller inactivates the drained source afterward.
 *
 * Idempotent: createJournalEntry hashes (realm, date, note, lines), so re-running
 * the same reclass won't double-post.
 */
import { createJournalEntry, type JournalEntryLine, type QBOAccount } from "@/lib/qbo";
import { fetchProfitAndLossByMonth } from "@/lib/qbo-pl-by-month";
import { normalizeAccountName } from "@/lib/account-name";

const MONTH_IDX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Apr 2026" → "2026-04-30" (month-end). Null if the title isn't a month. */
function monthEndFromTitle(title: string): string | null {
  const m = String(title || "").trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const mi = MONTH_IDX[m[1].slice(0, 3).toLowerCase()];
  if (mi == null) return null;
  const year = parseInt(m[2], 10);
  const lastDay = new Date(year, mi + 1, 0).getDate(); // day 0 of next month = last day of this
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function isCreditNormal(accountType: string): boolean {
  const t = (accountType || "").toLowerCase();
  return t === "income" || t === "other income" || t === "equity";
}

export interface JeReclassResult {
  /** Total absolute amount moved across all months. */
  moved: number;
  jesPosted: number;
  monthsWithActivity: number;
  failures: string[];
  /** True if the source account appeared in the P&L for the range at all. */
  foundInReport: boolean;
}

export async function reclassAccountViaJournalEntry(params: {
  realmId: string;
  accessToken: string;
  source: QBOAccount;
  target: QBOAccount;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  memo: string;
}): Promise<JeReclassResult> {
  const { realmId, accessToken, source, target, startDate, endDate, memo } = params;

  const pl = await fetchProfitAndLossByMonth(realmId, accessToken, startDate, endDate);
  const monthDates = pl.months.map((m) => monthEndFromTitle(m.title));

  // Locate the source account's monthly values (match on normalized full name,
  // or the leaf when the report flattened it to "Parent:Child").
  const wantFull = normalizeAccountName(source.Name);
  const wantLeaf = wantFull.split(":").pop() || wantFull;
  let row: { values: number[] } | null = null;
  for (const b of pl.blocks) {
    if (b.kind !== "section") continue;
    for (const a of b.accounts) {
      const norm = normalizeAccountName(a.name);
      if (norm === wantFull || (norm.split(":").pop() || norm) === wantLeaf) { row = a; break; }
    }
    if (row) break;
  }

  const result: JeReclassResult = {
    moved: 0, jesPosted: 0, monthsWithActivity: 0, failures: [], foundInReport: !!row,
  };
  if (!row) return result; // no P&L activity in the range — nothing to move

  const creditNormal = isCreditNormal(source.AccountType);
  for (let i = 0; i < row.values.length; i++) {
    const v = row.values[i];
    if (Math.abs(v) < 0.01) continue;
    const date = monthDates[i];
    if (!date) { result.failures.push(`${pl.months[i]?.title || `col ${i}`}: could not derive a posting date`); continue; }
    result.monthsWithActivity++;

    const amount = Math.abs(v);
    let sourcePosting: "Debit" | "Credit" = creditNormal ? "Debit" : "Credit";
    let targetPosting: "Debit" | "Credit" = creditNormal ? "Credit" : "Debit";
    if (v < 0) {
      sourcePosting = sourcePosting === "Debit" ? "Credit" : "Debit";
      targetPosting = targetPosting === "Debit" ? "Credit" : "Debit";
    }
    const lines: JournalEntryLine[] = [
      { posting_type: sourcePosting, amount, account_id: source.Id, account_name: source.Name, description: memo },
      { posting_type: targetPosting, amount, account_id: target.Id, account_name: target.Name, description: memo },
    ];
    try {
      await createJournalEntry(realmId, accessToken, {
        txn_date: date,
        private_note: `${memo} [${pl.months[i]?.title || date}]`,
        lines,
      });
      result.jesPosted++;
      result.moved += amount;
    } catch (e: any) {
      result.failures.push(`${pl.months[i]?.title || date}: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return result;
}
