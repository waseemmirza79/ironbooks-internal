import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { UfAiClient } from "./uf-ai-client";

export const dynamic = "force-dynamic";

/**
 * /balance-sheet/[client_id]/uf-ai — Undeposited Funds AI Reconcile
 *
 * Bookkeeper uploads two QBO transaction reports (AR + UF) and Claude
 * matches payments to deposits, identifies stuck items, and emits step-
 * by-step QBO instructions. CSV-driven so it works even when our QBO
 * refresh tokens are dead — bookkeeper can still pull the CSVs from
 * QBO directly via QBOA.
 */
export default async function UfAiPage({
  params,
}: {
  params: Promise<{ client_id: string }>;
}) {
  const { client_id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") redirect("/portal");

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, qbo_realm_id")
    .eq("id", client_id)
    .single();
  if (!client) notFound();

  return (
    <AppShell>
      <TopBar
        title={`UF Reconcile — ${(client as any).client_name}`}
        subtitle="Undeposited Funds AI analysis · upload CSVs, get a cleanup plan"
      />
      <div className="px-8 py-6 max-w-6xl">
        <UfAiClient
          clientLinkId={client_id}
          clientName={(client as any).client_name || "Client"}
          hasQbo={!!(client as any).qbo_realm_id}
        />
      </div>
    </AppShell>
  );
}
