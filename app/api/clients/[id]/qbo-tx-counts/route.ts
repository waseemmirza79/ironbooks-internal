import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken, qboRateLimiter, qboErrorResponse } from "@/lib/qbo";

/**
 * GET /api/clients/[id]/qbo-tx-counts?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Diagnostic endpoint: returns COUNT(*) per major QBO transaction type
 * for the date range. Built to answer the question "why does reclass
 * discovery find 0 transactions for client X?" — without it, we're
 * blind to which transaction types are actually populated in their QBO.
 *
 * Uses QBO's `SELECT COUNT(*) FROM <Type>` syntax, which is dramatically
 * faster than fetching the rows. We fire all queries in parallel and
 * accept partial failure (some Intuit deployments don't support every
 * type) — failed queries return `null` so the UI can show "unsupported"
 * rather than crashing.
 *
 * Internal-only (bookkeeper / lead / admin).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The full set of QBO transaction-list types we care about for reclass
// diagnostics. Order chosen so the most-common-for-reclass land at top
// when sorted by count. SUPPORTED in current SUPPORTED_TX_TYPES flagged
// so the UI can highlight which ones the scanner already covers.
const TX_TYPES: Array<{ name: string; supportedByReclass: boolean; description: string }> = [
  { name: "Bill", supportedByReclass: true, description: "Vendor bills" },
  { name: "Purchase", supportedByReclass: true, description: "Checks / credit card charges" },
  { name: "Expense", supportedByReclass: true, description: "Direct expenses" },
  { name: "VendorCredit", supportedByReclass: true, description: "Vendor credits" },
  { name: "JournalEntry", supportedByReclass: false, description: "Manual JEs — common with accountant-style bookkeeping" },
  { name: "Deposit", supportedByReclass: false, description: "Bank deposits" },
  { name: "Transfer", supportedByReclass: true, description: "Between-account transfers (From/To reclassify via lib/qbo-transfers)" },
  { name: "BillPayment", supportedByReclass: false, description: "Payments against bills (already-categorized)" },
  { name: "Invoice", supportedByReclass: false, description: "Customer invoices (income side)" },
  { name: "SalesReceipt", supportedByReclass: false, description: "Direct sales receipts (income side)" },
  { name: "Payment", supportedByReclass: false, description: "Customer payments" },
  { name: "CreditMemo", supportedByReclass: false, description: "Customer credit memos" },
  { name: "RefundReceipt", supportedByReclass: false, description: "Refunds to customers" },
];

const QBO_BASE =
  process.env.QBO_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

async function countQboType(
  realmId: string,
  accessToken: string,
  txType: string,
  startDate: string,
  endDate: string
): Promise<number | null> {
  // QBO's count syntax: SELECT COUNT(*) FROM <Type> WHERE ...
  // Returns the count inline in the QueryResponse.totalCount field.
  await qboRateLimiter.throttle(realmId);
  const query = encodeURIComponent(
    `SELECT COUNT(*) FROM ${txType} WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`
  );
  const url = `${QBO_BASE}/v3/company/${realmId}/query?query=${query}&minorversion=70`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      // Type unsupported on this realm, or malformed query — return null.
      // Logging the body helps when a specific tenant rejects a type that
      // works elsewhere (rare but happens).
      const body = await res.text();
      console.warn(`[qbo-tx-counts] ${txType} returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    // QBO returns the count in QueryResponse.totalCount (or 0 if no rows).
    // Some minor versions also surface it as QueryResponse[txType] empty array.
    const total = data?.QueryResponse?.totalCount;
    if (typeof total === "number") return total;
    return 0;
  } catch (err: any) {
    console.warn(`[qbo-tx-counts] ${txType} threw:`, err?.message);
    return null;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json({ error: "start and end required (YYYY-MM-DD)" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("qbo_realm_id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!clientLink || !(clientLink as any).qbo_realm_id) {
    return NextResponse.json({ error: "Client not connected to QBO" }, { status: 404 });
  }
  const realmId = (clientLink as any).qbo_realm_id as string;

  let accessToken: string;
  try {
    accessToken = await getValidToken(clientLinkId, service as any);
  } catch (err: any) {
    return qboErrorResponse(err);
  }

  // Fire all counts in parallel. With QBO's rate limiter throttle this is
  // ~13 cheap queries → ~3-5 seconds total. Each result is independent so
  // one timeout doesn't kill the rest.
  const counts = await Promise.all(
    TX_TYPES.map(async (t) => {
      const count = await countQboType(realmId, accessToken, t.name, start, end);
      return {
        type: t.name,
        count,
        supported_by_reclass: t.supportedByReclass,
        description: t.description,
      };
    })
  );

  // Summary rollups: how many of "current SUPPORTED_TX_TYPES" exist vs
  // the unsupported types we'd need to expand into. Drives the "if you
  // add JEs you'd catch N more transactions" recommendation.
  const supportedCount = counts
    .filter((c) => c.supported_by_reclass)
    .reduce((s, c) => s + (c.count || 0), 0);
  const unsupportedCount = counts
    .filter((c) => !c.supported_by_reclass)
    .reduce((s, c) => s + (c.count || 0), 0);

  return NextResponse.json({
    client_name: (clientLink as any).client_name,
    realm_id: realmId,
    date_range: { start, end },
    summary: {
      currently_supported_total: supportedCount,
      currently_unsupported_total: unsupportedCount,
      recommendation:
        supportedCount === 0 && unsupportedCount > 0
          ? `This client's expense activity is in transaction types reclass doesn't scan. Top unsupported types: ${counts
              .filter((c) => !c.supported_by_reclass && (c.count || 0) > 0)
              .sort((a, b) => (b.count || 0) - (a.count || 0))
              .slice(0, 3)
              .map((c) => `${c.type} (${c.count})`)
              .join(", ")}.`
          : supportedCount > 0
          ? "Reclass scan should find activity — investigate filters if discovery returns 0."
          : "No transactions in this date range. Either the range is wrong, or the QBO connection is failing silently.",
    },
    counts: counts.sort((a, b) => (b.count || 0) - (a.count || 0)),
  });
}
