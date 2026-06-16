import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { verifyGhlWebhook } from "@/lib/ghl";
import {
  extractContactId,
  extractContactFields,
  upsertLeadFromWebhook,
  applyOnboardingFormToProfile,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/ghl/ob-form
 *
 * Fired when the client completes the onboarding form in GHL. Stamps
 * ob_form_submitted_at and stores the submission so the card can show the key
 * answers (business name, entity type, etc. — finalized once we see a real
 * payload). Creates the lead if the WON webhook hasn't arrived yet
 * (order-independent).
 *
 * GHL setup: Form submitted trigger → Webhook action → this URL with the
 * `x-snap-webhook-secret` header.
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
    console.warn("[ghl/ob-form] no contact id in payload", Object.keys(payload || {}));
    return NextResponse.json({ error: "Missing contact id" }, { status: 422 });
  }

  const service = createServiceSupabase();
  const result = await upsertLeadFromWebhook(service, "ob_form", contactId, payload, {
    ob_form_submitted_at: new Date().toISOString(),
    ob_form_payload: payload,
    ...extractContactFields(payload),
  });

  if (!result.ok) {
    console.error("[ghl/ob-form] upsert failed:", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // If this lead has already been promoted to a SNAP client, push the form
  // answers straight onto that client's profile (blanks-only). For leads not
  // yet converted, the create_client handoff applies the same mapping from the
  // stored ob_form_payload. Fail-soft — never break the webhook ack over this.
  let profileFilled = 0;
  try {
    const { data: lead } = await (service as any)
      .from("onboarding_leads")
      .select("client_link_id")
      .eq("id", result.id)
      .single();
    if (lead?.client_link_id) {
      const r = await applyOnboardingFormToProfile(service, lead.client_link_id, payload);
      profileFilled = r.filled;
      if (r.error) console.warn("[ghl/ob-form] profile fill error:", r.error);
    }
  } catch (e: any) {
    console.warn("[ghl/ob-form] profile fill skipped:", e?.message);
  }

  return NextResponse.json({ ok: true, lead_id: result.id, profile_filled: profileFilled });
}
