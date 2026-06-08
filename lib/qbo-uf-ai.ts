/**
 * QBO data plumbing for the UF AI Reconcile tool.
 *
 * Pulls the Accounts Receivable + Undeposited Funds transaction lists
 * straight from QBO and flattens them into the exact same CSV shape a
 * bookkeeper would get from "Reports → Transaction List by Account →
 * Export to CSV". The Claude prompt in lib/uf-ai-prompt.ts is unchanged
 * — it works the same whether the CSVs come from a manual export or
 * from this live pull.
 */

import { qboRequest } from "./qbo";

/**
 * Look up the AR account ID. Most QBO files have exactly one. If multiple
 * (e.g. multi-currency setups), we return the first non-credit one and
 * caller can decide whether to expose all of them.
 */
export async function findAccountsReceivableAccountId(
  realmId: string,
  accessToken: string
): Promise<string | null> {
  const query = encodeURIComponent(
    `SELECT Id, Name FROM Account WHERE AccountType = 'Accounts Receivable'`
  );
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const rows: any[] = data?.QueryResponse?.Account || [];
  return rows[0]?.Id || null;
}

/**
 * Look up the Undeposited Funds account ID. Duplicates the helper in
 * lib/qbo-balance-sheet.ts so this file is self-contained; consider
 * unifying later if a third caller appears.
 */
export async function findUndepositedFundsAccountIdForUfAi(
  realmId: string,
  accessToken: string
): Promise<string | null> {
  const query = encodeURIComponent(
    `SELECT Id, Name FROM Account WHERE AccountSubType = 'UndepositedFunds'`
  );
  const data: any = await qboRequest(realmId, accessToken, `/query?query=${query}`);
  const rows: any[] = data?.QueryResponse?.Account || [];
  return rows[0]?.Id || null;
}

/**
 * QBO report rows are nested (section headers, group rollups, then
 * ColData arrays for actual transaction rows). This walker flattens
 * them into plain rows of strings keyed by column title.
 */
function walkReportRows(
  rows: any[],
  columnTitles: string[],
  out: Array<Record<string, string>>
): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    // Data row — ColData is parallel to the column list
    if (row.ColData && Array.isArray(row.ColData)) {
      const record: Record<string, string> = {};
      row.ColData.forEach((cell: any, i: number) => {
        const title = columnTitles[i] || `col_${i}`;
        record[title] = String(cell?.value ?? "").trim();
      });
      // Skip purely empty rows (section dividers sometimes appear as
      // all-blank ColData under group headers).
      if (Object.values(record).some((v) => v.length > 0)) {
        out.push(record);
      }
    }
    // Nested rows (group/section)
    if (row.Rows?.Row) {
      walkReportRows(row.Rows.Row, columnTitles, out);
    }
    // Summary rows — capture so the prompt can see ending balances
    if (row.Summary?.ColData && Array.isArray(row.Summary.ColData)) {
      const sumRecord: Record<string, string> = { __summary_for: row.group || "" };
      row.Summary.ColData.forEach((cell: any, i: number) => {
        const title = columnTitles[i] || `col_${i}`;
        sumRecord[title] = String(cell?.value ?? "").trim();
      });
      out.push(sumRecord);
    }
  }
}

/**
 * Serialize an array of records as CSV text — minimal RFC-4180 quoting,
 * just enough so Claude reads it the same way it'd read a manual export.
 */
function toCsv(rows: Array<Record<string, string>>, columns: string[]): string {
  const escape = (v: string) => {
    if (v == null) return "";
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const header = columns.map(escape).join(",");
  const body = rows
    .map((r) => columns.map((c) => escape(r[c] ?? "")).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

export interface TransactionListResult {
  /** The CSV the bookkeeper would get from "Export to CSV" in QBO */
  csv: string;
  /** Header line shown in QBO reports like "Date Range: 2025-01-01 to 2025-12-31"
   *  — captured so the prompt can verify period in its analysis */
  reportTitle: string | null;
  rowCount: number;
}

/**
 * Pull the Transaction List by Account report for a single account from
 * QBO and flatten to a CSV string. Mirrors what QBO's "Reports →
 * Transaction List by Account → Export → To CSV" produces.
 *
 * Returned CSV preserves the standard QBO column titles so the Claude
 * prompt's column-name detection works identically across manual-export
 * and live-pull paths.
 */
export async function fetchTransactionListAsCsv(
  realmId: string,
  accessToken: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<TransactionListResult> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    account: accountId,
    // Default QBO export columns — matches what bookkeepers get from
    // "Reports → Transaction List by Account → Export → To CSV"
    columns: [
      "tx_date",
      "txn_type",
      "doc_num",
      "is_no_post",
      "name",
      "memo",
      "account_name",
      "split_acc",
      "subt_nat_amount",
    ].join(","),
    minorversion: "70",
  });

  const data: any = await qboRequest(
    realmId,
    accessToken,
    `/reports/TransactionList?${params.toString()}`
  );

  const columns = data?.Columns?.Column || [];
  const columnTitles: string[] = columns.map((c: any) => c?.ColTitle || c?.ColType || "col");

  // Friendly aliases — the report API gives back terse internal-style
  // titles ("subt_nat_amount") that QBO's CSV export presents as
  // human-readable headers ("Amount"). Remap to match the export so the
  // Claude prompt's column-aliasing logic recognizes them.
  const TITLE_ALIASES: Record<string, string> = {
    tx_date: "Date",
    txn_type: "Transaction Type",
    doc_num: "Num",
    is_no_post: "Posting",
    name: "Name",
    memo: "Memo/Description",
    account_name: "Account",
    split_acc: "Split",
    subt_nat_amount: "Amount",
    "Total Amount": "Amount",
    "Account name": "Account",
    "Split account": "Split",
    "Memo / Description": "Memo/Description",
    "Memo/Description": "Memo/Description",
    "Transaction date": "Date",
    "Document number": "Num",
    "Posting status": "Posting",
  };
  const friendlyTitles = columnTitles.map((t) => TITLE_ALIASES[t] || t);

  const rows: Array<Record<string, string>> = [];
  if (data?.Rows?.Row) walkReportRows(data.Rows.Row, friendlyTitles, rows);

  const csv = toCsv(rows, friendlyTitles);

  return {
    csv,
    reportTitle: data?.Header?.ReportName || null,
    rowCount: rows.length,
  };
}
