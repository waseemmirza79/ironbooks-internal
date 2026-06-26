import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { signUpForTrainingCalls } from "@/lib/ghl";

export const dynamic = "force-dynamic";

/**
 * POST /api/portal/training-signup
 *
 * Opt the signed-in client into the weekly training-calls reminder automation.
 * The opt-in is always recorded in audit_log first (source of truth), then we
 * try to enroll them in the GHL reminder workflow. If GHL isn't wired yet the
 * opt-in is still captured and the client gets a positive response — Mike sees
 * the opt-ins and the workflow enrolls everyone once GHL_TRAINING_WORKFLOW_ID
 * is set.
 */
export async function POST() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) {
    return NextResponse.json({ error: "No portal context" }, { status: 403 });
  }
  const ctx = ctxResult.ctx;

  if (ctx.impersonating) {
    return NextResponse.json(
      { error: "Sign-up is disabled while impersonating." },
      { status: 403 }
    );
  }

  const service = createServiceSupabase();
  // select("*") is resilient — some of these columns (contact_first_name,
  // client_phone) post-date the generated types and a named select would 400
  // if any were absent on this environment.
  const { data: cl } = await service
    .from("client_links")
    .select("*")
    .eq("id", ctx.clientLinkId)
    .single();

  const c = (cl as any) || {};
  const email = (c.client_email || "").trim();
  if (!email) {
    return NextResponse.json(
      { error: "We don't have an email on file. Message us and we'll add you." },
      { status: 400 }
    );
  }
  const name =
    [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") ||
    c.client_name ||
    null;

  // Record the opt-in first so it's never lost, even if GHL is unreachable.
  await service.from("audit_log").insert({
    event_type: "training_call_optin",
    request_payload: { client_link_id: ctx.clientLinkId, email, source: "portal" } as any,
  });

  try {
    await signUpForTrainingCalls({ email, name, phone: c.client_phone || null });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // GHL not configured / unreachable — the opt-in is logged; surface a
    // positive but honest message and let an admin enroll them.
    console.warn("[training-signup] GHL enroll failed:", e?.message);
    return NextResponse.json({ ok: true, queued: true });
  }
}
