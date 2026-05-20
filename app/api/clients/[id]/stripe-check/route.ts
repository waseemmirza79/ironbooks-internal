import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { NextResponse } from "next/server";

const QBO_BASE = "https://quickbooks.api.intuit.com";

/**
 * POST /api/clients/[id]/stripe-check
 *
 * Queries the client's QBO deposits from the last 90 days for Stripe-pattern
 * transactions (payee/memo contains "stripe", amount ≥ $1,000). Sets
 * stripe_detected = true/false on client_links.
 *
 * Returns: { stripe_detected: boolean, match_count: number }
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: client } = await service
    .from("client_links")
    .select("id, qbo_realm_id, stripe_connection_status")
    .eq("id", clientId)
    .single();

  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // If already connected, no need to scan
  if (client.stripe_connection_status === "connected") {
    await service.from("client_links").update({ stripe_detected: true } as any).eq("id", clientId);
    return NextResponse.json({ stripe_detected: true, match_count: 0, already_connected: true });
  }

  try {
    const accessToken = await getValidToken(clientId, service as any);
    const realmId = client.qbo_realm_id;

    const since = new Date();
    since.setDate(since.getDate() - 90);
    const sinceStr = since.toISOString().split("T")[0];

    // Query deposits — look for Name or PrivateNote containing "stripe"
    const query = encodeURIComponent(
      `SELECT * FROM Deposit WHERE TxnDate >= '${sinceStr}' MAXRESULTS 500`
    );
    const url = `${QBO_BASE}/v3/company/${realmId}/query?query=${query}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`QBO query failed: ${res.status}`);
    }

    const data = await res.json();
    const deposits: any[] = data?.QueryResponse?.Deposit || [];

    let matchCount = 0;
    for (const deposit of deposits) {
      const lines: any[] = deposit.Line || [];
      for (const line of lines) {
        const amount = line.Amount || 0;
        const memo = (line.Description || "").toLowerCase();
        const entityName = (
          line.DepositLineDetail?.Entity?.name ||
          deposit.PrivateNote ||
          ""
        ).toLowerCase();

        if (
          amount >= 1000 &&
          (memo.includes("stripe") || entityName.includes("stripe"))
        ) {
          matchCount++;
        }
      }
    }

    const detected = matchCount > 0;
    await service
      .from("client_links")
      .update({ stripe_detected: detected } as any)
      .eq("id", clientId);

    return NextResponse.json({ stripe_detected: detected, match_count: matchCount });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
