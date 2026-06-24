import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { WorkflowBoard } from "./workflow-board";
import type { OnboardingLead } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * /workflow — the single board for the whole client journey, segmented
 * Onboarding → Cleanup → Production. Each segment mounts the existing,
 * proven board so this is composition, not a rebuild: one obvious place to
 * see who's where, instead of three separate routes. (V1 keeps /onboarding,
 * /cleanup, /production standalone; the V2 sidebar points only here.)
 */
export default async function WorkflowPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  const role = (actor as any)?.role || "";
  const isSenior = role === "admin" || role === "lead";

  // Onboarding segment data (senior only) — same source as /onboarding.
  let leads: OnboardingLead[] = [];
  let bookkeepers: { id: string; full_name: string }[] = [];
  if (isSenior) {
    try {
      const { data } = await (service as any)
        .from("onboarding_leads")
        .select("*")
        .eq("status", "active")
        .order("won_at", { ascending: true, nullsFirst: false });
      leads = (data as OnboardingLead[]) || [];
    } catch {
      leads = [];
    }
    const { data: bks } = await service
      .from("users")
      .select("id, full_name, role")
      .eq("is_active", true)
      .in("role", ["admin", "lead", "bookkeeper"])
      .order("full_name");
    bookkeepers = ((bks as any[]) || [])
      .filter((b) => b.full_name)
      .map((b) => ({ id: b.id, full_name: b.full_name }));
  }

  const { view } = await searchParams;
  const initialView = (["onboarding", "cleanup", "production"].includes(view || "")
    ? (view as string)
    : "cleanup") as "onboarding" | "cleanup" | "production";

  return (
    <AppShell>
      <TopBar
        title="Workflow"
        subtitle="Onboarding → Cleanup → Production · every active client, one board"
      />
      <div className="px-8 py-6 max-w-7xl">
        <WorkflowBoard
          initialView={initialView}
          isSenior={isSenior}
          onboardingLeads={leads}
          bookkeepers={bookkeepers}
        />
      </div>
    </AppShell>
  );
}
