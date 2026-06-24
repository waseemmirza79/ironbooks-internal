import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { resolveClientContactEmails } from "@/lib/client-comms";
import { buildStripeConnectEmail } from "@/lib/stripe-connect-email";
import { buildStatementRequestEmail } from "@/lib/statement-request-email";

export const dynamic = "force-dynamic";

/**
 * GET /api/clients/[id]/preview-email?type=stripe_connect|bs_statements&...
 *
 * Renders the EXACT branded email that would be sent (same builders), plus the
 * resolved recipient list / no-address state — so the UI can show a
 * preview-before-send. Does NOT send anything and does NOT mint a Stripe token
 * (the connect preview uses a placeholder link; the real 7-day link is minted
 * only on the confirmed send).
 *
 * Query:
 *   type:           'stripe_connect' | 'bs_statements'
 *   labels:         JSON array of statement labels (bs_statements only)
 *   isReminder:     '1' for the softer reminder copy (stripe_connect)
 *   override_email: preview/send to this address instead of the one on file
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "";
  const isReminder = url.searchParams.get("isReminder") === "1";
  const override = (url.searchParams.get("override_email") || "").trim().toLowerCase();

  const service = createServiceSupabase();
  const { data: cl } = await service
    .from("client_links")
    .select("client_name, email_hard_bounced")
    .eq("id", clientLinkId)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });
  const clientName = (cl as any).client_name || "your business";

  // Resolve recipients exactly like the send paths do.
  let recipients: string[] = [];
  let noAddress = false;
  let addressNote: string | undefined;
  if (override) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override)) {
      noAddress = true;
      addressNote = "That doesn't look like a valid email address.";
    } else {
      recipients = [override];
    }
  } else if ((cl as any).email_hard_bounced) {
    noAddress = true;
    addressNote = "The email on file previously bounced — enter a new address.";
  } else {
    recipients = await resolveClientContactEmails(service, clientLinkId);
    if (recipients.length === 0) noAddress = true;
  }

  let html = "";
  let subject = "";
  if (type === "stripe_connect") {
    const base = process.env.NEXT_PUBLIC_BASE_URL || "https://internal.ironbooks.com";
    const placeholderUrl = `${base}/stripe-connect/EXAMPLE-LINK`;
    const firstName = clientName.split(" ")[0] || "there";
    const built = buildStripeConnectEmail(firstName, placeholderUrl, clientName, { isReminder });
    html = built.html;
    subject = isReminder
      ? `Reminder: connect Stripe so we can finish your books — ${clientName}`
      : `Connect Stripe so we can reconcile your books — ${clientName}`;
  } else if (type === "bs_statements") {
    let labels: string[] = [];
    try {
      const raw = url.searchParams.get("labels");
      if (raw) labels = JSON.parse(raw);
    } catch {
      /* ignore — empty list renders an empty preview */
    }
    const built = buildStatementRequestEmail(clientName, Array.isArray(labels) ? labels : []);
    html = built.html;
    subject = built.subject;
  } else {
    return NextResponse.json({ error: "Unknown email type" }, { status: 400 });
  }

  return NextResponse.json({
    email_type: type,
    html,
    subject,
    recipients,
    no_address: noAddress,
    address_note: addressNote,
    client_name: clientName,
  });
}
