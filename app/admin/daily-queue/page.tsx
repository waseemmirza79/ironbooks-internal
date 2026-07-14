import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { DrainClient } from "./drain-client";

export const dynamic = "force-dynamic";

/** /admin/daily-queue — one-shot backlog drain through the reviewed vendor rules. */
export default async function DailyQueueAdminPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if ((actor as any)?.role !== "admin") redirect("/");

  const { count } = await (service as any)
    .from("daily_review_queue")
    .select("*", { count: "exact", head: true })
    .eq("decision", "pending");

  return (
    <AppShell>
      <TopBar
        title="Daily Queue — Backlog Drain"
        subtitle="Re-run pending review items through the reviewed vendor rules; confident ones auto-post, the rest stay for humans"
      />
      <div className="px-8 py-6 max-w-3xl">
        <DrainClient pendingCount={count ?? 0} />
      </div>
    </AppShell>
  );
}
