import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken, qboErrorResponse } from "@/lib/qbo";
import { NextResponse } from "next/server";

/**
 * GET /api/clients/[id]/qbo-accounts
 *
 * Returns the live QBO chart of accounts for a client.
 * Used by the reclass setup form to populate source/target dropdowns.
 *
 * Cached very lightly (response is freshly fetched each call - QBO data changes).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: clientLink } = await service
    .from("client_links")
    .select("id, qbo_realm_id, is_active")
    .eq("id", id)
    .single();

  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  if (!clientLink.is_active) {
    return NextResponse.json({ error: "Client is inactive" }, { status: 400 });
  }

  try {
    const accessToken = await getValidToken(clientLink.id, service as any);
    const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);

    // Return compact list, only active accounts, with the fields we need
    const compact = accounts
      .filter((a: any) => a.Active !== false)
      .map((a: any) => ({
        id: a.Id,
        name: a.Name,
        fullyQualifiedName: a.FullyQualifiedName || a.Name,
        accountType: a.AccountType || "",
        accountSubType: a.AccountSubType || "",
        currentBalance: a.CurrentBalance || 0,
        classification: a.Classification || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ accounts: compact });
  } catch (e) {
    // Surfaces QBOReauthRequiredError as 401 + reconnect_url so the
    // client can route the user to /api/qbo/connect cleanly.
    return qboErrorResponse(e);
  }
}
