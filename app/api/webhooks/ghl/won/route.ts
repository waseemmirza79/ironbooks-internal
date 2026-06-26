import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/won
 *
 * Fired by the GHL workflow when an opportunity is marked WON. Creates (or
 * updates) the onboarding lead and stamps won_at — the start of the
 * onboarding clock.
 *
 * GHL setup: Workflow trigger "Opportunity Status Changed → Won" → Webhook
 * action → this URL, with header `x-snap-webhook-secret: <GHL_WEBHOOK_SECRET>`.
 *
 * Field mapping is best-effort (see lib/onboarding.ts `pick`/`extract*`); the
 * full raw payload is stored so we can finalize the mapping against a real
 * sample without losing anything.
 */
export async function POST(request: Request) {
  if (!verifyGhlWebhook(request)) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = extractContactId(payload);
  if (!contactId) {
    console.warn("[ghl/won] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const service = createServiceSupabase();
  const result = await upsertLeadFromWebhook(service, "won", contactId, payload, {
    won_at: new Date().toISOString(),
    ...extractContactFields(payload),
  });

  if (!result.ok) {
    console.error("[ghl/won] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // On WON, create the SNAP client right away (status=onboarding) so it exists
  // before the onboarding form arrives. Idempotent: reuse the lead's linked
  // client, else an existing client with the same email, else create one.
  const cf = extractContactFields(payload);
  const emailLc = (cf.email ? String(cf.email) : "").trim().toLowerCase();
  let clientLinkId: string | null = null;
  let createdClient = false;
  try {
    const { data: lead } = await (service as any)
      .from("onboarding_leads").select("client_link_id").eq("id", result.id).maybeSingle();
    clientLinkId = lead?.client_link_id || null;

    if (!clientLinkId && emailLc) {
      const { data: ex } = await (service as any)
        .from("client_links").select("id").ilike("client_email", emailLc).limit(1).maybeSingle();
      clientLinkId = ex?.id || null;
    }
    if (!clientLinkId) {
      const fullName = (cf.full_name || "").trim();
      const sp = fullName.indexOf(" ");
      const { data: created, error } = await (service as any)
        .from("client_links")
        .insert({
          client_name: cf.business_name || fullName || "New client (won)",
          client_email: cf.email || null,
          client_phone: cf.phone || null,
          contact_first_name: sp > 0 ? fullName.slice(0, sp) : fullName || null,
          contact_last_name: sp > 0 ? fullName.slice(sp + 1) : null,
          status: "onboarding",
          is_active: true,
        })
        .select("id").single();
      if (!error && created) { clientLinkId = created.id; createdClient = true; }
    }
    if (clientLinkId) {
      await (service as any).from("onboarding_leads")
        .update({ client_link_id: clientLinkId }).eq("id", result.id);
      await service.from("audit_log").insert({
        event_type: createdClient ? "ghl_won_created_client" : "ghl_won_linked_client",
        request_payload: { lead_id: result.id, client_link_id: clientLinkId, email: cf.email, created: createdClient } as any,
      });
    }
  } catch (e: any) {
    console.warn("[ghl/won] client create/link skipped:", e?.message);
  }

  return NextResponse.json({ ok: true, lead_id: result.id, client_link_id: clientLinkId, created_client: createdClient });
}
