import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * Auth callback — exchanges the magic-link code for a session, then routes
 * the user to either the bookkeeper dashboard or the client portal based
 * on their role.
 *
 * Order of preference for the redirect destination:
 *   1. Explicit `next` query param — invite emails drop you on a specific page
 *   2. role='client'    → /portal
 *   3. everything else  → /dashboard
 *
 * Service client reads the role row so we don't depend on RLS policies
 * being wired up against the session that just got issued.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const explicitNext = searchParams.get("next");

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/auth/login?error=oauth_failed`);
  }

  if (explicitNext) {
    return NextResponse.redirect(`${origin}${explicitNext}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  const service = createServiceSupabase();
  const { data: profile } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if ((profile as any)?.role === "client") {
    // Stamp last_login + first_login (if not already set) + audit log.
    // Best-effort — never blocks the redirect on a DB hiccup.
    try {
      const now = new Date().toISOString();

      // Read prior state so we can tell first-login-vs-returning in the audit entry
      const { data: priorMapping } = await service
        .from("client_users" as any)
        .select("first_login_at, client_link_id")
        .eq("user_id", user.id)
        .maybeSingle();

      await service
        .from("client_users" as any)
        .update({ last_login_at: now } as any)
        .eq("user_id", user.id);
      await service
        .from("client_users" as any)
        .update({ first_login_at: now } as any)
        .eq("user_id", user.id)
        .is("first_login_at", null);

      const isFirstLogin = !(priorMapping as any)?.first_login_at;
      await service.from("audit_log").insert({
        event_type: isFirstLogin ? "portal_first_login" : "portal_login",
        user_id: user.id,
        request_payload: {
          client_link_id: (priorMapping as any)?.client_link_id ?? null,
        } as any,
      });
    } catch {
      // ignore — telemetry shouldn't break login
    }
    return NextResponse.redirect(`${origin}/portal`);
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
