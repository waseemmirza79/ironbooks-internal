import { getAuthorizeUrl } from "@/lib/qbo";
import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import crypto from "crypto";

/**
 * GET /api/qbo/connect
 *
 * Initiates the QBO OAuth flow.
 * Stores a CSRF state token in a cookie and redirects to Intuit.
 *
 * Optional query params:
 *  - client_link_id: link this QBO connection to an existing client
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const clientLinkId = searchParams.get("client_link_id") || "new";

  // Generate CSRF state
  const stateValue = crypto.randomBytes(32).toString("hex");
  const stateData = `${stateValue}.${clientLinkId}.${user.id}`;

  const authUrl = await getAuthorizeUrl(stateData);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set("qbo_oauth_state", stateValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,  // 10 minutes
    path: "/",
  });

  return response;
}
