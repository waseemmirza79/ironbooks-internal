import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { BulkEmailClient } from "./bulk-email-client";

export const dynamic = "force-dynamic";

export default async function BulkEmailPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role, email, full_name").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) redirect("/dashboard");

  return (
    <AppShell>
      <TopBar title="Bulk email" subtitle="Email some or all clients · operational + marketing · unsubscribe-aware" />
      <div className="px-8 py-6 max-w-6xl">
        <BulkEmailClient senderEmail={(actor as any)?.email || ""} senderName={(actor as any)?.full_name || "Ironbooks"} />
      </div>
    </AppShell>
  );
}
