import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { NewStripeReconForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewStripeReconPage({
  searchParams,
}: {
  searchParams?: Promise<{ client?: string }>;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const sp = (await searchParams) || {};
  const preselectId = sp.client || null;

  // Picker source. Use the auth-scoped client + select("*") — exactly like
  // the COA / Reclass / Bank-Rules pages. Naming explicit columns here was
  // the bug: the old PICKER_COLS list referenced Stripe payout-health columns
  // (stripe_has_payouts / stripe_last_payout_at / stripe_payouts_checked_at)
  // that don't exist in the DB, so the query 400'd and the dropdown came back
  // EMPTY on every environment. select("*") returns whatever columns exist and
  // never errors on a missing one.
  //
  // Cleanup-completed clients stay selectable here (a secondary Stripe-API
  // recon is a valid post-completion delta op; execute is idempotent). The
  // form annotates them. Exclude only clients flagged "doesn't use Stripe"
  // (stripe_not_required) — using .or() so NULL rows are kept (.eq(false)
  // would silently drop clients created before the column existed).
  const { data: clientLinks, error: pickerError } = await supabase
    .from("client_links")
    .select("*")
    .eq("is_active", true)
    .or("stripe_not_required.is.null,stripe_not_required.eq.false" as any)
    .order("client_name");
  if (pickerError) {
    // Previously this error was swallowed and the page rendered an EMPTY
    // client picker — a dead end that read as "there are no clients".
    console.error(`[stripe-recon/new] picker query failed: ${pickerError.message}`);
  }
  let list = (clientLinks as unknown as any[]) || [];

  // Deep-link safety: when arriving with ?client= (reclass handoff,
  // stepper, cleanup board), make sure that client is in the list even if
  // the roster query failed or a flag filtered it out — the handoff must
  // never dead-end on the page you were just sent to.
  if (preselectId && !list.some((c) => c.id === preselectId)) {
    const { data: one } = await supabase
      .from("client_links")
      .select("*")
      .eq("id", preselectId)
      .maybeSingle();
    if (one) list = [one as any, ...list];
  }

  return (
    <AppShell>
      <TopBar
        title="Stripe AR Reconciliation"
        subtitle="Match Stripe deposits to customer invoices · calculate fees + sales tax"
      />
      <WorkflowStepper
        currentStep="stripe"
        currentState="active"
        completedSteps={["coa", "reclass", "rules"]}
        clientLinkId={preselectId || undefined}
      />
      <div className="px-8 py-6 max-w-3xl">
        {/* Cast through unknown because cleanup_completed_at lives in
            migration 19 and the regenerated supabase types haven't been
            pulled. Runtime shape is correct. */}
        <NewStripeReconForm
          clientLinks={list}
          initialClientId={preselectId && list.some((c) => c.id === preselectId) ? preselectId : null}
        />
      </div>
    </AppShell>
  );
}
