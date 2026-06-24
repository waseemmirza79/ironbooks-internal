/**
 * Stripe connection-request reminder sweep. Run daily by the cron; the cadence
 * gating is in-query (every ~3 days) because "every 3 days" isn't a crontab
 * expression. For each client that was sent a connect request but hasn't
 * connected:
 *   - age < 9 days: resend the branded email if it's been ≥3 days since the last.
 *   - age ≥ 9 days: create a "call the client" Today task (team_tasks), stamp
 *     stripe_connect_task_created_at so this never fires twice, and stop emailing.
 */

import { createServiceSupabase } from "@/lib/supabase";
import { sendStripeConnectionRequest } from "@/lib/stripe-connection-request";

const DAY = 86_400_000;
const REMINDER_INTERVAL_DAYS = 3;
const ESCALATE_AFTER_DAYS = 9;

export async function runStripeConnectionReminder() {
  const service = createServiceSupabase();
  const { data: rows, error } = await service
    .from("client_links")
    .select(
      "id, client_name, stripe_connect_requested_at, stripe_connect_last_reminder_at, stripe_connect_reminder_count, stripe_connection_status, stripe_not_required, stripe_connect_task_created_at"
    )
    .eq("is_active", true)
    .eq("stripe_connection_status", "pending")
    .not("stripe_connect_requested_at", "is", null)
    .is("stripe_connect_task_created_at", null);

  if (error) {
    console.error(`[stripe-connection-reminder] query failed: ${error.message}`);
    return { scanned: 0, reminded: 0, escalated: 0, skipped: 0, error: error.message };
  }

  const now = Date.now();
  let scanned = 0, reminded = 0, escalated = 0, skipped = 0;

  for (const c of (rows as any[]) || []) {
    scanned++;
    try {
      if (c.stripe_not_required) { skipped++; continue; }
      const requestedAt = new Date(c.stripe_connect_requested_at).getTime();
      const ageDays = Math.floor((now - requestedAt) / DAY);

      if (ageDays >= ESCALATE_AFTER_DAYS) {
        // De-dup: don't create a second open call-task for the same client.
        const { data: existing } = await service
          .from("team_tasks")
          .select("id")
          .eq("client_link_id", c.id)
          .in("status", ["todo", "in_progress"])
          .ilike("title", "%Stripe%")
          .limit(1)
          .maybeSingle();
        if (!existing) {
          await service.from("team_tasks").insert({
            title: `Call ${c.client_name} about connecting Stripe`,
            notes: `Stripe deposits detected but Stripe still not connected after ${ageDays} days. ${c.stripe_connect_reminder_count || 0} reminder email(s) sent since ${new Date(requestedAt).toLocaleDateString()}. Use "Resend connect link" to send a fresh link, or call them.`,
            priority: "high",
            status: "todo",
            client_link_id: c.id,
            due_date: new Date(now).toISOString().slice(0, 10),
            created_by: null,
          } as any);
        }
        await service
          .from("client_links")
          .update({ stripe_connect_task_created_at: new Date(now).toISOString() } as any)
          .eq("id", c.id);
        escalated++;
      } else {
        const lastReminder = c.stripe_connect_last_reminder_at
          ? new Date(c.stripe_connect_last_reminder_at).getTime()
          : 0;
        const daysSinceLast = (now - lastReminder) / DAY;
        if (!c.stripe_connect_last_reminder_at || daysSinceLast >= REMINDER_INTERVAL_DAYS) {
          const r = await sendStripeConnectionRequest(service, {
            clientLinkId: c.id,
            createdByUserId: null,
            isReminder: true,
          });
          if (r.sent) reminded++;
          else skipped++;
        } else {
          skipped++;
        }
      }
    } catch (e: any) {
      console.warn(`[stripe-connection-reminder] ${c.id} failed: ${e?.message}`);
    }
  }

  return { scanned, reminded, escalated, skipped };
}
