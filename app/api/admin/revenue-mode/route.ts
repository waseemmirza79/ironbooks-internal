import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { normalizeRevenueMode } from "@/lib/revenue-recognition";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/revenue-mode
 *   { client_link_id: string, mode: "standard" | "deposits_only" }
 *
 * Sets a client's revenue-recognition mode (see lib/revenue-recognition.ts —
 * deposits_only excludes CRM invoice-recognized income from cash-basis revenue
 * in monthly production + the close-verification gate). Reversible; the change
 * is audit-logged with old → new. Admin or lead (Mike + Lisa walk the
 * remediation screen together).
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden — admin or lead only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const clientLinkId = String(body.client_link_id || "").trim();
  const mode = normalizeRevenueMode(body.mode);
  if (!clientLinkId) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }
  // normalizeRevenueMode maps junk to 'standard' — reject junk explicitly so a
  // typo can't silently flip a client back to standard.
  if (body.mode !== "standard" && body.mode !== "deposits_only") {
    return NextResponse.json({ error: "mode must be 'standard' or 'deposits_only'" }, { status: 400 });
  }

  const { data: client } = await (service as any)
    .from("client_links")
    .select("id, client_name, revenue_recognition_mode")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const oldMode = normalizeRevenueMode((client as any).revenue_recognition_mode);
  if (oldMode === mode) {
    return NextResponse.json({ ok: true, client_link_id: clientLinkId, mode, changed: false });
  }

  const { error: upErr } = await (service as any)
    .from("client_links")
    .update({ revenue_recognition_mode: mode })
    .eq("id", clientLinkId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  try {
    await service.from("audit_log").insert({
      event_type: "revenue_recognition_mode_change",
      user_id: user.id,
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        old_mode: oldMode,
        new_mode: mode,
      } as any,
    });
  } catch {
    /* audit failure never blocks the change */
  }

  return NextResponse.json({ ok: true, client_link_id: clientLinkId, mode, changed: true });
}
