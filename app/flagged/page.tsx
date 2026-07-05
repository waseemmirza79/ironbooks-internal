import { redirect } from "next/navigation";

/**
 * /flagged → /approvals.
 *
 * The flagged-for-senior-review queue merged into Approvals (July 2026) —
 * one senior queue for statements, files, escalations, and flagged items.
 */
export default function FlaggedRedirect() {
  redirect("/approvals");
}
