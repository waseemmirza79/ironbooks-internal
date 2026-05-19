import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { getProvinceTax } from "@/lib/canadian-tax";
import { ShieldAlert, ReceiptText } from "lucide-react";
import { TaxAuditPanel } from "./tax-audit-panel";

export default async function TaxAuditPage({
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

  if (!client) {
    return (
      <AppShell>
        <TopBar title="GST/HST Tax Audit" />
        <div className="px-8 py-12">
          <div className="rounded-xl bg-red-50 border border-red-200 p-8 text-center max-w-md">
            <p className="text-red-800 font-semibold">Client not found.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (client.jurisdiction !== "CA") {
    return (
      <AppShell>
        <TopBar title="GST/HST Tax Audit" subtitle={client.client_name} />
        <div className="px-8 py-12 max-w-2xl">
          <div className="rounded-2xl p-8 bg-amber-50 border border-amber-200 text-center">
            <ShieldAlert size={36} className="mx-auto text-amber-600 mb-3" />
            <h2 className="text-lg font-bold text-navy mb-2">Canadian clients only</h2>
            <p className="text-sm text-ink-slate">
              The GST/HST Audit is only available for clients with Canadian jurisdiction.
              This client is set to <strong>{client.jurisdiction}</strong>.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const province = getProvinceTax(client.state_province);

  return (
    <AppShell>
      <TopBar
        title="GST/HST Tax Audit"
        subtitle={`${client.client_name} · ${province?.name ?? client.state_province} · ${province?.display ?? ""}`}
      />
      <div className="px-8 py-6 max-w-4xl">
        <div className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-teal-light border border-teal/20">
          <ReceiptText size={20} className="text-teal flex-shrink-0" />
          <p className="text-sm text-navy">
            This audit pulls the P&L from QuickBooks for the selected period and runs three
            compliance checks: account inventory, sales tax collected vs. revenue, and the 50%
            meals ITC rule. Results are advisory — always verify against the actual GST/HST return.
          </p>
        </div>
        <TaxAuditPanel
          clientId={client_id}
          clientName={client.client_name}
          provinceCode={client.state_province ?? ""}
          taxRateDisplay={province?.display ?? ""}
        />
      </div>
    </AppShell>
  );
}
