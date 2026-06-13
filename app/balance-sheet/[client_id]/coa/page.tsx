import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BsCoaTreeClient } from "./tree-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/coa
 *
 * Standalone Balance Sheet COA viewer — every BS account in the client's
 * QBO COA, with hierarchy + balances + per-account "View transactions"
 * link that routes into the existing scrub-mode reclass for that account.
 *
 * Distinct from the workflow Step 5 page (which is the bank-recon form).
 * This is a read-only inspector for now; edit actions (add/rename/
 * inactivate/re-parent) come in Phase 3.
 */
export default async function BalanceSheetCoaPage({
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
    .select("id, client_name, jurisdiction, state_province")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  const c = client as any;

  return (
    <AppShell>
      <TopBar
        title={`Balance Sheet COA — ${c.client_name}`}
        subtitle="View every Balance Sheet account and quickly reclass or fix transactions. Use this for one-off fixes; use the reconciliation form for a full cleanup."
      />
      <div className="px-8 py-6 max-w-6xl space-y-4">
        <Link
          href={`/balance-sheet/${c.id}`}
          className="inline-flex items-center gap-1 text-sm text-ink-slate hover:text-navy"
        >
          <ArrowLeft size={14} />
          Back to Balance Sheet workflow
        </Link>

        <BsCoaTreeClient clientLinkId={c.id} clientName={c.client_name} />
      </div>
    </AppShell>
  );
}
