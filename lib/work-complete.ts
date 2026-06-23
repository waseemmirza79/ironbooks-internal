/**
 * "Work complete" recorder — the SNAP-native replacement for DoubleHQ's
 * task-board posts. When a deliverable milestone finishes (COA cleanup,
 * month-end close) this writes a queryable audit_log row so completions are
 * visible in-app.
 *
 * NOTE: this intentionally does NOT email the firm's admins/leads. Per policy,
 * SNAP sends NO internal completion emails — the only outbound mail is the
 * branded, client-facing "your statements are ready" email (sent separately
 * by lib/month-end/email.ts during package delivery). The completion record
 * lives in the audit log / in-app surfaces, not in anyone's inbox.
 *
 * Best-effort: a DB hiccup never blocks the job that just finished.
 */

export async function notifyWorkComplete(
  service: any,
  params: {
    kind: string;          // e.g. "COA cleanup", "Month-end close"
    clientLinkId: string;
    summary: string;       // one-line detail, e.g. "182 renamed, 14 created"
    actorName?: string | null;
  }
): Promise<void> {
  // Resolve the client name (callers only have the id).
  let clientName = "a client";
  try {
    const { data } = await service
      .from("client_links")
      .select("client_name")
      .eq("id", params.clientLinkId)
      .single();
    if (data?.client_name) clientName = data.client_name;
  } catch {
    /* name is cosmetic — fall back */
  }

  // Audit trail only (queryable record of every completion — no email).
  try {
    await service.from("audit_log").insert({
      event_type: "work_complete",
      request_payload: {
        kind: params.kind,
        client_link_id: params.clientLinkId,
        client_name: clientName,
        summary: params.summary,
        actor: params.actorName || null,
      } as any,
    });
  } catch {
    /* ignore — best-effort */
  }
}
