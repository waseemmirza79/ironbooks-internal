import { sendMonthEndEmail } from "./email";
import { periodBounds } from "./period";
import { getPortalRecipients } from "./recipients";
import {
  claimPackageForSend,
  releaseSendClaim,
  recoverStaleMonthEndPackages,
  type MonthEndPackageRow,
} from "./claim";
import { verifyOperationalGates } from "./operational-gates";
import { SEND_CONCURRENCY } from "./constants";
import { mapPool } from "./concurrency";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface SendPackageResult {
  packageId: string;
  clientLinkId: string;
  clientName: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  emailMessageId?: string;
}

async function loadClientName(
  service: Service,
  pkg: MonthEndPackageRow
): Promise<string> {
  if ((pkg as any).client_links?.client_name) {
    return (pkg as any).client_links.client_name;
  }
  const { data } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", pkg.client_link_id)
    .single();
  return data?.client_name || "Client";
}

async function finalizeSuccessfulSend(
  service: Service,
  pkg: MonthEndPackageRow,
  sentBy: string,
  lastMessageId: string | undefined,
  partialErrors: string[]
): Promise<void> {
  const now = new Date().toISOString();
  const period = periodBounds({
    periodYear: pkg.period_year,
    periodMonth: pkg.period_month,
  });

  const { data: finalized } = await service
    .from("month_end_packages")
    .update({
      status: "sent",
      portal_published_at: now,
      email_sent_at: now,
      email_message_id: lastMessageId || null,
      sent_by: sentBy,
      send_error: partialErrors.length ? partialErrors.join("; ").slice(0, 2000) : null,
      updated_at: now,
    } as any)
    .eq("id", pkg.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();

  if (!finalized) {
    throw new Error("Finalize failed — package status changed during send");
  }

  await service
    .from("client_links")
    .update({ latest_closed_period: pkg.period_end } as any)
    .eq("id", pkg.client_link_id);

  if (pkg.reclass_job_id) {
    await service
      .from("reclass_jobs")
      .update({
        month_closed_at: now,
        month_closed_by: sentBy,
      } as any)
      .eq("id", pkg.reclass_job_id)
      .is("month_closed_at", null);
  }

  await service.from("audit_log").insert({
    event_type: "month_end_delivered",
    user_id: sentBy,
    request_payload: {
      package_id: pkg.id,
      client_link_id: pkg.client_link_id,
      period_year: period.periodYear,
      period_month: period.periodMonth,
      email_message_id: lastMessageId,
      partial_email_errors: partialErrors.length ? partialErrors : null,
    },
  } as any);
}

export async function deliverPackage(
  service: Service,
  packageId: string,
  sentBy: string,
  appBaseUrl: string
): Promise<SendPackageResult> {
  const claim = await claimPackageForSend(service, packageId);
  if (!claim.ok) {
    return {
      packageId,
      clientLinkId: "",
      clientName: "",
      ok: false,
      error: claim.error,
    };
  }

  const pkg = claim.pkg;
  const clientLinkId = pkg.client_link_id;

  if (claim.alreadySent) {
    const clientName = await loadClientName(service, pkg);
    return {
      packageId,
      clientLinkId,
      clientName,
      ok: true,
      skipped: true,
    };
  }

  const period = periodBounds({
    periodYear: pkg.period_year,
    periodMonth: pkg.period_month,
  });

  const gates = await verifyOperationalGates(service, clientLinkId, period);
  if (!gates.ok) {
    const msg = `Operational gates failed at send time: ${gates.blockReasons.join(", ")}`;
    await releaseSendClaim(service, packageId, msg, "ready_to_send");
    const clientName = await loadClientName(service, pkg);
    return { packageId, clientLinkId, clientName, ok: false, error: msg };
  }

  const clientName = await loadClientName(service, pkg);
  const portalUrl = `${appBaseUrl}/portal/statements/${period.periodYear}/${period.periodMonth}`;
  const recipients = await getPortalRecipients(service, clientLinkId);

  if (!recipients.length) {
    await releaseSendClaim(service, packageId, "No portal recipients", "failed");
    return { packageId, clientLinkId, clientName, ok: false, error: "No portal recipients" };
  }

  let lastMessageId: string | undefined;
  const errors: string[] = [];

  try {
    for (const r of recipients) {
      const result = await sendMonthEndEmail({
        clientName,
        recipientEmail: r.email,
        recipientFirstName: r.firstName,
        period,
        aiSummaryExcerpt: pkg.ai_summary!,
        portalUrl,
      });
      if (result.ok) {
        lastMessageId = result.messageId;
      } else {
        errors.push(`${r.email}: ${result.error}`);
      }
    }

    if (errors.length === recipients.length) {
      await releaseSendClaim(service, packageId, errors.join("; "), "failed");
      return { packageId, clientLinkId, clientName, ok: false, error: errors.join("; ") };
    }

    await finalizeSuccessfulSend(service, pkg, sentBy, lastMessageId, errors);

    return {
      packageId,
      clientLinkId,
      clientName,
      ok: true,
      emailMessageId: lastMessageId,
      error: errors.length ? errors.join("; ") : undefined,
    };
  } catch (err: any) {
    const msg = err?.message || "Unexpected send failure";
    await releaseSendClaim(service, packageId, msg, "ready_to_send");
    return { packageId, clientLinkId, clientName, ok: false, error: msg };
  }
}

export async function deliverPackagesBulk(
  service: Service,
  packageIds: string[],
  sentBy: string,
  appBaseUrl: string
): Promise<{
  sent: number;
  failed: number;
  skipped: number;
  results: SendPackageResult[];
}> {
  await recoverStaleMonthEndPackages(service);

  const uniqueIds = [...new Set(packageIds)];
  const results = await mapPool(uniqueIds, SEND_CONCURRENCY, (id) =>
    deliverPackage(service, id, sentBy, appBaseUrl)
  );

  const sent = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.ok && r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return { sent, failed, skipped, results };
}
