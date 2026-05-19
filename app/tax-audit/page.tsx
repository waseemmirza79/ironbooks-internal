import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { getProvinceTax } from "@/lib/canadian-tax";
import Link from "next/link";
import { Receipt, ChevronRight } from "lucide-react";

export default async function TaxAuditIndexPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: clients } = await service
    .from("client_links")
    .select("id, client_name, state_province, jurisdiction")
    .eq("jurisdiction", "CA")
    .order("client_name");

  const canadianClients = (clients || []).map((c) => ({
    ...c,
    province: getProvinceTax(c.state_province),
  }));

  return (
    <AppShell>
      <TopBar
        title="GST/HST Tax Audit"
        subtitle={`${canadianClients.length} Canadian client${canadianClients.length !== 1 ? "s" : ""}`}
      />
      <div className="px-8 py-6 max-w-2xl">
        {canadianClients.length === 0 ? (
          <div className="rounded-xl bg-white border border-gray-200 px-8 py-16 text-center">
            <Receipt size={32} className="mx-auto text-ink-light mb-3" />
            <h3 className="font-bold text-navy mb-1">No Canadian clients</h3>
            <p className="text-sm text-ink-slate">
              Add a Canadian client in the Clients tab to run a GST/HST audit.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {canadianClients.map((c) => (
              <Link
                key={c.id}
                href={`/tax-audit/${c.id}`}
                className="flex items-center gap-4 bg-white border border-gray-100 rounded-xl px-5 py-4 hover:border-teal/30 hover:bg-teal-light/30 transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-navy">{c.client_name}</div>
                  <div className="text-sm text-ink-slate">
                    {c.province?.name ?? c.state_province} · {c.province?.display ?? ""}
                  </div>
                </div>
                <ChevronRight size={16} className="text-ink-light group-hover:text-teal transition-colors" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
