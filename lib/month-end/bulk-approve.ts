import { AI_SUMMARY_MIN_LEN } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export async function bulkApproveSummaries(
  service: Service,
  packageIds: string[],
  reviewedBy: string
): Promise<{ approved: number; failed: number; errors: string[] }> {
  const now = new Date().toISOString();
  let approved = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const id of packageIds) {
    const { data: pkg } = await service
      .from("month_end_packages")
      .select("id, status, ai_summary")
      .eq("id", id)
      .maybeSingle();

    if (!pkg) {
      failed++;
      errors.push(`${id}: not found`);
      continue;
    }

    if ((pkg as any).status === "sent") {
      failed++;
      errors.push(`${id}: already sent`);
      continue;
    }

    const summary = ((pkg as any).ai_summary || "").trim();
    if (summary.length < AI_SUMMARY_MIN_LEN) {
      failed++;
      errors.push(`${id}: summary too short (min ${AI_SUMMARY_MIN_LEN} chars)`);
      continue;
    }

    const { data: updated } = await service
      .from("month_end_packages")
      .update({
        ai_summary_reviewed: true,
        ai_summary_reviewed_by: reviewedBy,
        ai_summary_reviewed_at: now,
        status: "ready_to_send",
        updated_at: now,
      } as any)
      .eq("id", id)
      .in("status", ["draft", "failed", "ready_to_send"])
      .select("id")
      .maybeSingle();

    if (updated) {
      approved++;
    } else {
      failed++;
      errors.push(`${id}: status not approvable`);
    }
  }

  return { approved, failed, errors };
}
