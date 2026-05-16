"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import {
  Search, ArrowRight, MapPin, CheckCircle2, Plus, Loader2, Globe2,
} from "lucide-react";
import type { Database } from "@/lib/database.types";
import { CANADIAN_PROVINCES, getProvinceTax } from "@/lib/canadian-tax";

type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

export function NewJobForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ClientLink | null>(null);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<"client" | "jurisdiction">("client");

  // Editable jurisdiction state (initialized from client_link when selected)
  const [country, setCountry] = useState<"US" | "CA">("US");
  const [province, setProvince] = useState<string>("");

  useEffect(() => {
    const clientId = searchParams.get("client");
    if (clientId && !selected) {
      const found = clientLinks.find((c) => c.id === clientId);
      if (found) {
        setSelected(found);
        setCountry((found.jurisdiction as "US" | "CA") || "US");
        setProvince(found.state_province || "");
        setStep("jurisdiction");
      }
    }
  }, [searchParams, clientLinks]);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const filtered = clientLinks.filter((c) =>
    c.client_name.toLowerCase().includes(search.toLowerCase())
  );

  function pickClient(c: ClientLink) {
    setSelected(c);
    setCountry((c.jurisdiction as "US" | "CA") || "US");
    setProvince(c.state_province || "");
    setStep("jurisdiction");
  }

  const provinceTax = getProvinceTax(province);
  const needsProvince = country === "CA";
  const canStart = !!selected && (!needsProvince || !!province);

  async function startJob() {
    if (!selected || !canStart) return;
    setCreating(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("Not signed in");
      setCreating(false);
      return;
    }

    const jurisdictionChanged = selected.jurisdiction !== country;
    const provinceChanged = (selected.state_province || "") !== province;
    if (jurisdictionChanged || provinceChanged) {
      const { error: clientErr } = await supabase
        .from("client_links")
        .update({
          jurisdiction: country,
          state_province: province || null,
        })
        .eq("id", selected.id);
      if (clientErr) {
        alert(`Could not update client jurisdiction: ${clientErr.message}`);
        setCreating(false);
        return;
      }
    }

    const { data, error } = await supabase
      .from("coa_jobs")
      .insert({
        client_link_id: selected.id,
        bookkeeper_id: user.id,
        status: "draft",
      })
      .select()
      .single();

    if (error || !data) {
      alert(`Error creating job: ${error?.message}`);
      setCreating(false);
      return;
    }

    fetch(`/api/jobs/${data.id}/analyze`, { method: "POST" }).catch((e) =>
      console.error("Analysis kickoff failed:", e)
    );

    router.push(`/jobs/${data.id}/review`);
  }

  // ─────────── Step 1: client picker ───────────
  if (step === "client") {
    return (
      <div>
        {clientLinks.length === 0 && (
          <div className="rounded-xl p-6 mb-6 bg-yellow-50 border border-yellow-200">
            <h3 className="font-bold text-sm mb-2 text-navy">No clients connected yet</h3>
            <p className="text-sm text-ink-slate mb-4">
              Before you can run a cleanup, you need to connect a QuickBooks Online client.
            </p>
            <a
              href="/api/qbo/connect"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
            >
              <Plus size={16} />
              Connect QuickBooks Client
            </a>
          </div>
        )}

        <StepIndicator current="client" />

        <div className="rounded-xl bg-white border border-gray-200 mb-6">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="font-bold text-base text-navy">Step 1 · Select Client</h3>
            <p className="text-xs text-ink-slate">From your connected QBO + Double accounts</p>
          </div>

          <div className="p-5">
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
              <input
                type="text"
                placeholder="Search clients..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>

            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {filtered.map((client) => (
                <button
                  key={client.id}
                  onClick={() => pickClient(client)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left border-2 border-gray-100 hover:bg-teal-lighter hover:border-teal transition-colors"
                >
                  <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                    {client.client_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-navy">{client.client_name}</div>
                    <div className="text-xs flex items-center gap-2 text-ink-slate">
                      <MapPin size={11} /> {client.jurisdiction} {client.state_province && `· ${client.state_province}`}
                    </div>
                  </div>
                  <ArrowRight size={16} className="text-ink-light" />
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-sm text-ink-slate py-4 text-center">No clients match your search.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─────────── Step 2: country & province ───────────
  return (
    <div>
      <StepIndicator current="jurisdiction" />

      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-base text-navy">Step 2 · Confirm Country & Province</h3>
            <p className="text-xs text-ink-slate">
              Determines the master COA template and (Canada only) sales tax codes
            </p>
          </div>
          <button
            onClick={() => setStep("client")}
            className="text-xs font-semibold text-ink-slate hover:text-navy"
          >
            ← Change client
          </button>
        </div>

        <div className="p-5 space-y-5">
          {selected && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-teal-lighter border border-teal/30">
              <div className="rounded-md flex items-center justify-center font-bold text-xs w-9 h-9 bg-white text-teal border border-teal/30">
                {selected.client_name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-navy">{selected.client_name}</div>
                <div className="text-xs text-ink-slate">Selected client</div>
              </div>
              <CheckCircle2 size={18} className="text-teal" />
            </div>
          )}

          <div>
            <label className="flex items-center gap-1.5 text-sm font-semibold text-navy mb-2">
              <Globe2 size={14} /> Country
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(["US", "CA"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setCountry(c);
                    if (c === "US") setProvince("");
                  }}
                  className={`px-4 py-3 rounded-lg border-2 text-sm font-semibold transition-colors ${
                    country === c
                      ? "bg-teal-lighter border-teal text-teal"
                      : "bg-white border-gray-200 hover:border-gray-300 text-navy"
                  }`}
                >
                  {c === "US" ? "United States" : "Canada"}
                </button>
              ))}
            </div>
          </div>

          {country === "CA" && (
            <div>
              <label className="text-sm font-semibold text-navy mb-2 block">
                Province / Territory
              </label>
              <select
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
              >
                <option value="">Select province or territory…</option>
                {CANADIAN_PROVINCES.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} ({p.display})
                  </option>
                ))}
              </select>

              {provinceTax && (
                <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-100">
                  <div className="text-xs font-bold uppercase tracking-wider text-blue-900 mb-1">
                    Sales Tax — {provinceTax.name}
                  </div>
                  <div className="text-sm font-semibold text-blue-800">{provinceTax.display}</div>
                  <div className="text-xs text-blue-700 mt-1">
                    Combined effective rate: <span className="font-bold">{(provinceTax.combined * 100).toFixed(provinceTax.combined === 0.14975 ? 3 : 0)}%</span>
                  </div>
                  <div className="text-[11px] text-blue-600 mt-2">
                    Tax codes will be applied during reclassification and bank rule generation.
                  </div>
                </div>
              )}
            </div>
          )}

          {country === "US" && (
            <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
              <div className="text-xs text-ink-slate">
                US clients — no transaction-level sales tax applied. Master COA uses the US template.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={startJob}
          disabled={!canStart || creating}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
        >
          {creating ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
          {creating ? "Starting..." : "Pull COA & Start Review"}
        </button>
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: "client" | "jurisdiction" }) {
  return (
    <div className="flex items-center gap-2 mb-5 text-xs font-semibold">
      <span className={current === "client" ? "text-teal" : "text-ink-light"}>1. Client</span>
      <span className="text-ink-light">→</span>
      <span className={current === "jurisdiction" ? "text-teal" : "text-ink-light"}>2. Country & Province</span>
      <span className="text-ink-light">→</span>
      <span className="text-ink-light">3. Review</span>
    </div>
  );
}
