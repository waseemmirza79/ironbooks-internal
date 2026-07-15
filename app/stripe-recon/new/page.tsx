import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { NewStripeReconForm } from "./form";

export const dynamic = "force-dynamic";

const PICKER_COLS =
  "id, client_name, jurisdiction, state_province, qbo_realm_id, double_client_id, double_client_name, stripe_connection_status, cleanup_completed_at, stripe_has_payouts, stripe_last_payout_at, stripe_payouts_checked_at";

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

  const service = createServiceSupabase();
  // Cleanup-completed clients are normally hidden from the picker — they
  // live in the Completed Accounts table on /clients with a Reopen
  // button. BUT for the Stripe-recon flow specifically they remain
  // selectable, because a "secondary" Stripe-API recon is a valid
  // post-completion delta op once a client connects Stripe: the execute
  // step is idempotent (strips prior [Ironbooks] lines and rewrites
  // deterministic ones), so re-running on a completed client doesn't
  // break their close-out. The form annotates completed clients in the
  // dropdown so it's obvious.
  // Exclude clients flagged as "doesn't use Stripe" — the entire
  // recon flow is suppressed for them. (Bookkeepers can re-enable from
  // the comms-tracker on the client card if circumstances change.)
  // Filter: include clients where stripe_not_required is false OR null.
  // The .eq("stripe_not_required", false) variant excludes NULL rows in
  // Postgres, which silently dropped any client created before that column
  // existed (Power Painting, May 2026 — Stripe connected, but stripe_not_required
  // was NULL, so the client never showed up in this picker).
  const { data: clientLinks, error: pickerError } = await service
    .from("client_links")
    .select(PICKER_COLS)
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
    const { data: one } = await service
      .from("client_links")
      .select(PICKER_COLS)
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
        completedSteps={["coa", "reclass", "revenue", "rules"]}
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
