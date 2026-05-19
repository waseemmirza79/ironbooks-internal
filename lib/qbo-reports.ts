/**
 * QBO Reports API — fetch and parse P&L and account data for tax audit.
 *
 * QBO report responses are deeply nested. We use a recursive flattener to
 * build a label→value map, then look up keys by common name variants.
 */

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function fetchQBOReport(
  realmId: string,
  accessToken: string,
  reportName: string,
  params: Record<string, string>
): Promise<any> {
  const qs = new URLSearchParams({ ...params, minorversion: "65" });
  const url = `${QBO_BASE}/v3/company/${realmId}/reports/${reportName}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO ${reportName} report failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Report row types ───────────────────────────────────────────────────────

interface ReportRow {
  type?: string;
  ColData?: { value: string; id?: string }[];
  Rows?: { Row?: ReportRow[] };
  Header?: { ColData?: { value: string }[] };
  Summary?: { ColData?: { value: string }[] };
  group?: string;
}

// Walk report rows recursively and build two maps:
//   flat:    label (lowercase) → number value  (Data rows + Section summaries)
//   items:   label → number  (only leaf Data rows, for line-level display)
function flattenRows(
  rows: ReportRow[],
  flat: Map<string, number> = new Map(),
  items: { label: string; amount: number; group: string }[] = [],
  currentGroup = ""
): { flat: Map<string, number>; items: { label: string; amount: number; group: string }[] } {
  for (const row of rows || []) {
    const group = row.group || currentGroup;

    if (row.type === "Data" && row.ColData) {
      const label = (row.ColData[0]?.value || "").trim();
      const value = parseFloat(row.ColData[1]?.value || "0") || 0;
      if (label) {
        flat.set(label.toLowerCase(), value);
        items.push({ label, amount: value, group });
      }
    }

    const sectionGroup =
      row.Header?.ColData?.[0]?.value?.trim() || group;

    if (row.Rows?.Row) {
      flattenRows(row.Rows.Row, flat, items, sectionGroup);
    }

    if (row.type === "Section" && row.Summary?.ColData) {
      const label = (row.Summary.ColData[0]?.value || "").trim();
      const value = parseFloat(row.Summary.ColData[1]?.value || "0") || 0;
      if (label) flat.set(label.toLowerCase(), value);
    }
  }
  return { flat, items };
}

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ProfitLossData {
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  /** Net value of all meal/entertainment accounts found */
  mealsExpense: number;
  /** All meal/entertainment account names and amounts */
  mealsAccounts: { label: string; amount: number }[];
  /** Every line item in the P&L for display */
  lineItems: { label: string; amount: number; group: string }[];
}

export interface GstHstAccount {
  name: string;
  id: string;
  balance: number;
  type: "payable" | "receivable" | "other";
}

// ─── Fetch P&L ───────────────────────────────────────────────────────────────

export async function fetchProfitAndLoss(
  realmId: string,
  accessToken: string,
  startDate: string,
  endDate: string
): Promise<ProfitLossData> {
  const report = await fetchQBOReport(realmId, accessToken, "ProfitAndLoss", {
    start_date: startDate,
    end_date: endDate,
    accounting_method: "Accrual",
  });

  const rawRows: ReportRow[] = report?.Rows?.Row || [];
  const { flat, items } = flattenRows(rawRows);

  const totalIncome =
    flat.get("total income") ??
    flat.get("total revenue") ??
    flat.get("gross profit") ??
    0;
  const totalExpenses =
    flat.get("total expenses") ?? flat.get("total expense") ?? 0;
  const netIncome =
    flat.get("net income") ??
    flat.get("net loss") ??
    flat.get("net earnings") ??
    0;

  // Match meal/entertainment accounts by common name variants
  const mealPatterns = [
    "meals and entertainment",
    "meals & entertainment",
    "meals & ent",
    "entertainment",
    "business meals",
    "meals",
    "client entertainment",
    "staff meals",
    "food and entertainment",
  ];

  const mealsAccounts = items.filter(({ label }) =>
    mealPatterns.some((p) => label.toLowerCase().includes(p))
  );
  const mealsExpense = mealsAccounts.reduce((s, a) => s + Math.abs(a.amount), 0);

  return {
    totalIncome: Math.abs(totalIncome),
    totalExpenses: Math.abs(totalExpenses),
    netIncome,
    mealsExpense,
    mealsAccounts,
    lineItems: items,
  };
}

// ─── Find GST/HST accounts from the fetched account list ────────────────────
// Using the account list (rather than Balance Sheet report) is simpler and
// gives us CurrentBalance directly. Limitation: CurrentBalance reflects the
// current date, not the end of the selected period — noted in the UI.

export function extractGstHstAccounts(accounts: any[]): GstHstAccount[] {
  const taxKeywords = ["gst", "hst", "sales tax", "tax payable", "tax receivable", "input tax"];
  return accounts
    .filter((a: any) => {
      const name = (a.Name || "").toLowerCase();
      return taxKeywords.some((kw) => name.includes(kw));
    })
    .map((a: any) => {
      const name: string = a.Name;
      const nameLower = name.toLowerCase();
      const accountType: string = (a.AccountType || "").toLowerCase();
      const type: "payable" | "receivable" | "other" =
        nameLower.includes("payable") || accountType === "other current liability"
          ? "payable"
          : nameLower.includes("receivable") || nameLower.includes("itc") || nameLower.includes("input tax") || accountType === "other current asset"
          ? "receivable"
          : "other";
      return {
        name,
        id: a.Id as string,
        balance: (a.CurrentBalanceWithSubAccounts ?? a.CurrentBalance ?? 0) as number,
        type,
      };
    });
}
