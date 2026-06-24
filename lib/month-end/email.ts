import type { PeriodBounds } from "./types";
import { resolveFromEmail } from "@/lib/email-sender";

export interface MonthEndEmailParams {
  clientName: string;
  recipientEmail: string;
  recipientFirstName: string;
  period: PeriodBounds;
  aiSummaryExcerpt: string;
  portalUrl: string;
}

export async function sendMonthEndEmail(
  params: MonthEndEmailParams
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = resolveFromEmail(
    process.env.MONTH_END_FROM_EMAIL,
    process.env.SUPPORT_FROM_EMAIL
  );

  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const subject = `Your ${params.period.label} financial statements are ready — ${params.clientName}`;
  const excerpt = params.aiSummaryExcerpt.split("\n").filter(Boolean).slice(0, 2).join(" ");

  const text = [
    `Hi ${params.recipientFirstName},`,
    ``,
    `Your books for ${params.period.label} are closed and reconciled. Here's a quick summary:`,
    ``,
    excerpt,
    ``,
    `View your full statements in the Ironbooks portal:`,
    params.portalUrl,
    ``,
    `Questions? Reply to this email or use Ask AI in your portal.`,
    ``,
    `— The Ironbooks team`,
  ].join("\n");

  // Branded HTML — inline styles only (email clients strip <style>). Mirrors
  // the navy/teal card used by the portal-notification emails so every client
  // email looks consistent. The plain-text above stays as the fallback.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const summaryHtml = esc(params.aiSummaryExcerpt.trim()).replace(/\n/g, "<br/>");
  const html = `
<div style="background:#F4F5F7;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E5E7EB;">
    <div style="background:#0F1F2E;padding:22px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Ironbooks</div>
      <div style="color:#8CD3CC;font-size:12px;margin-top:2px;">Advancing Financial Literacy In The Trades</div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 8px;color:#0F1F2E;font-size:18px;">Your ${esc(params.period.label)} statements are ready ✅</h2>
      <p style="margin:0 0 14px;color:#33414E;font-size:14px;line-height:1.55;">Hi ${esc(params.recipientFirstName)}, your books for ${esc(params.period.label)} are closed and reconciled. Here's a quick summary:</p>
      <div style="background:#F8FAFA;border:1px solid #E5E7EB;border-left:3px solid #1A9B8F;border-radius:8px;padding:14px 16px;margin:0 0 22px;color:#33414E;font-size:14px;line-height:1.6;">
        ${summaryHtml}
      </div>
      <a href="${params.portalUrl}" style="display:inline-block;background:#1A9B8F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 22px;border-radius:8px;">View your full statements →</a>
      <div style="background:#FCFCFD;border:1px solid #EEF0F2;border-radius:8px;padding:12px 14px;margin:22px 0 0;color:#8A94A0;font-size:11px;line-height:1.6;">
        <strong style="color:#5B6770;">Notice to Reader:</strong> These statements are prepared on a cash basis from your QuickBooks data — they don't reflect accounts receivable, accounts payable, or your full cash-flow cycle, and haven't been audited or reviewed. For a true read on your business, look at trends over at least a 90-day period rather than any single month.
      </div>
      <p style="color:#8A94A0;font-size:12px;margin:18px 0 0;line-height:1.5;">
        Questions? Just reply to this email, or use <strong>Ask AI</strong> in your portal.
      </p>
    </div>
  </div>
  <div style="max-width:560px;margin:12px auto 0;text-align:center;color:#9AA3AD;font-size:11px;">
    Ironbooks · your painting-business bookkeeping team
  </div>
</div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [params.recipientEmail],
        reply_to: process.env.SUPPORT_INBOX_EMAIL || "admin@ironbooks.com",
        subject,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${errText}` };
    }

    const body = await res.json();
    return { ok: true, messageId: body.id as string | undefined };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Resend network error" };
  }
}
