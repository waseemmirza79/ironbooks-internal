import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import { CpaClient } from "./cpa-client";

export const dynamic = "force-dynamic";

/**
 * /clients/[id]/cpa — CPA round-trip hub (senior-facing).
 *
 * Closes the loop with the client's accountant: diff their closing trial
 * balance against QBO, enter their AJEs, and tie filed tax amounts to the
 * ledger. Admin/lead only.
 */
export default async function CpaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) redirect("/dashboard");

  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name")
    .eq("id", id)
    .single();
  if (!client) notFound();

  return (
    <CpaClient
      clientId={id}
      company={(client as any).legal_business_name || (client as any).client_name}
    />
  );
}
