/**
 * Branded Stripe-connect request email — single source of truth for both the
 * copy-to-clipboard modal (StripeConnectModal) and the direct-send route
 * (/api/clients/[id]/send-stripe-request) + the reminder cron.
 *
 * Lifted verbatim from the old StripeConnectModal builders so the copy path and
 * the direct-send path are byte-identical, plus an `isReminder` variant that
 * softens the wording for the automated follow-ups.
 */

const BRAND = {
  teal: "#2D7A75",
  tealDark: "#1F5D58",
  tealLighter: "#F4F9F8",
  navy: "#0F1F2E",
  slate: "#475569",
  lightSlate: "#94A3B8",
  border: "#CBD5E1",
  white: "#FFFFFF",
  stripe: "#635BFF",
};

export function buildStripeConnectEmail(
  firstName: string,
  url: string,
  clientName: string,
  opts?: { isReminder?: boolean }
): { html: string; text: string } {
  const isReminder = !!opts?.isReminder;

  const introHtml = isReminder
    ? `Just a friendly follow-up — we're still finishing the cleanup of your books for ${clientName} and need to connect to your Stripe account to match your Stripe deposits to the invoices in QuickBooks. It only takes about 30 seconds:`
    : `As we clean up your books for ${clientName}, we'd like to connect to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks. This makes the books significantly more accurate and saves us hours of guesswork.`;
  const ctaIntroHtml = isReminder
    ? ""
    : `<p style="margin:0 0 18px 0;color:${BRAND.navy};line-height:1.55;">Click the button below to connect — it'll take about 30 seconds:</p>`;

  const html = `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;background:${BRAND.white};">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;width:54px;padding-right:14px;">
          <img src="https://internal.ironbooks.com/logo.png" alt="Ironbooks" width="44" height="44" style="display:block;width:44px;height:auto;" />
        </td>
        <td style="vertical-align:middle;color:${BRAND.white};">
          <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;color:${BRAND.white};">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Bookkeeping &middot; Cleanup</div>
        </td>
      </tr>
    </table>
  </div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Hi ${firstName},</p>
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">${introHtml}</p>
    ${ctaIntroHtml}
    <div style="text-align:center;margin:24px 0;">
      <a href="${url}" style="display:inline-block;background:${BRAND.stripe};color:${BRAND.white};font-weight:600;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Connect Stripe to Ironbooks &rarr;</a>
    </div>
    <div style="background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:8px;padding:14px 16px;margin:18px 0;">
      <div style="font-size:13px;font-weight:600;color:${BRAND.teal};margin-bottom:8px;">What this gives us</div>
      <ul style="margin:0;padding-left:18px;color:${BRAND.slate};font-size:13px;line-height:1.6;">
        <li><strong style="color:${BRAND.navy};">Just for reconciliation</strong> — we look at your payouts, charges, and balance transactions to match them to invoices</li>
        <li><strong style="color:${BRAND.navy};">No charges, no transfers</strong> — Ironbooks won't issue refunds, move money, or charge your customers</li>
        <li><strong style="color:${BRAND.navy};">Disconnect anytime</strong> — from your Stripe Dashboard (Settings &rarr; Connected applications), or just ask us</li>
      </ul>
    </div>
    <p style="margin:18px 0 0 0;color:${BRAND.navy};line-height:1.55;">The link expires in 7 days. If you have questions or want a walkthrough, just reply to this email.</p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Kindly,<br>Ironbooks</p>
    <div style="border-top:2px solid ${BRAND.teal};margin:24px 0 12px 0;width:60px;"></div>
    <div style="color:${BRAND.lightSlate};font-size:11px;line-height:1.5;">If the button above doesn't work, copy and paste this URL into your browser:<br><span style="color:${BRAND.teal};word-break:break-all;">${url}</span></div>
  </div>
</div>`;

  const introText = isReminder
    ? `Just a friendly follow-up — we're still finishing the cleanup of your books for ${clientName} and need to connect to your Stripe account to match your Stripe deposits to the invoices in QuickBooks.`
    : `As we clean up your books for ${clientName}, we'd like to connect to your Stripe account so we can match your Stripe deposits directly to the invoices in QuickBooks.`;

  const text = `Hi ${firstName},

${introText}

Click here to connect (takes about 30 seconds):
${url}

What this gives us:
  • Just for reconciliation — we look at your payouts, charges, and balance transactions to match them to invoices
  • No charges, no transfers — Ironbooks won't issue refunds, move money, or charge your customers
  • Disconnect anytime — from your Stripe Dashboard (Settings → Connected applications), or just ask us

The link expires in 7 days.

Kindly,
Ironbooks`;

  return { html, text };
}
