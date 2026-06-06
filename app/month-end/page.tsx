import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { defaultDeliveryPeriod } from "@/lib/month-end";
import { MonthEndClient } from "./month-end-client";

export const dynamic = "force-dynamic";

export default async function MonthEndPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role || "";
  if (!["admin", "lead"].includes(role)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const defaultPeriod = defaultDeliveryPeriod();
  const periodYear = Number(params.period_year) || defaultPeriod.periodYear;
  const periodMonth = Number(params.period_month) || defaultPeriod.periodMonth;

  return (
    <AppShell>
      <TopBar title="Month-End Delivery" />
      <MonthEndClient
        initialYear={periodYear}
        initialMonth={periodMonth}
        actorName={(actor as any)?.full_name || ""}
      />
    </AppShell>
  );
}
