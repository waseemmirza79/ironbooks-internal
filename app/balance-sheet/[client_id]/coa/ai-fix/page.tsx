import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BsAiFixClient } from "./ai-fix-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/coa/ai-fix
 *
 * AI-assisted BS cleanup. Three stages on a single page:
 *   1. Analyze — snapshot + Claude call
 *   2. Review — accept/modify/reject each AI-proposed fix
 *   3. Finalize — execute everything accepted, push to QBO
 *
 * Loads the most-recent run for this client (if any) so reopening the
 * page doesn't re-pay for the Claude call. If no run exists or the run
 * is failed/finalized, the UI offers a fresh Analyze button.
 */
export default async function BsAiFixPage({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, jurisdiction, state_province, assigned_bookkeeper_id")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  // Look for an in-progress or recently finalized run we can resume.
  // Migration 33 may not be applied yet — handle gracefully.
  let latestRun: any = null;
  try {
    const { data, error } = await service
      .from("bs_ai_fix_runs" as any)
      .select("*")
      .eq("client_link_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error) latestRun = data;
  } catch {
    // Migration not applied — leave latestRun null and UI shows "Analyze" CTA
  }

  return (
    <AppShell>
      <TopBar
        title={`AI BS Cleanup — ${(client as any).client_name}`}
        subtitle="Snapshot → AI analysis → review → finalize. Conservative pre-accept (≥95% confidence, low risk)."
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${client_id}/coa`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to BS COA viewer
        </Link>
        <BsAiFixClient
          clientLinkId={client_id}
          clientName={(client as any).client_name}
          latestRun={latestRun}
        />
      </div>
    </AppShell>
  );
}
