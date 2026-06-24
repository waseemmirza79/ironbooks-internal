"use client";

import { useState } from "react";
import Link from "next/link";
import { MapPin, ArrowRight, ChevronDown, ChevronRight, RefreshCw, CreditCard, Scale, Sparkles } from "lucide-react";
import type { RosterClient } from "@/lib/cleanup-roster";

function sortRows(rows: RosterClient[]): RosterClient[] {
  return [...rows].sort((a, b) => {
    if (a.highlight !== b.highlight) return a.highlight ? -1 : 1;
    return a.client_name.localeCompare(b.client_name);
  });
}

function Row({ c }: { c: RosterClient }) {
  const inner = (
    <div
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border-2 transition-colors ${
        c.highlight
          ? "border-teal/40 bg-teal-lighter hover:bg-teal-light"
          : "border-gray-100 hover:bg-gray-50 hover:border-gray-200"
      }`}
    >
      <div
        className={`rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 ${
          c.highlight ? "bg-teal text-white" : "bg-teal-light text-teal"
        }`}
      >
        {c.client_name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-navy truncate">{c.client_name}</div>
        <div className="text-xs flex items-center gap-2 text-ink-slate">
          {c.highlight ? (
            <span className="font-semibold text-teal">{c.subLabel}</span>
          ) : (
            <>
              <MapPin size={11} /> {c.jurisdiction} {c.state_province && `· ${c.state_province}`}
              <span className="text-ink-light">·</span> {c.subLabel}
            </>
          )}
        </div>
      </div>
      <ArrowRight size={16} className="text-ink-light flex-shrink-0" />
    </div>
  );
  return c.routeTarget ? (
    <Link href={c.routeTarget} className="block">{inner}</Link>
  ) : (
    inner
  );
}

function Section({
  title, icon: Icon, rows, defaultCollapsed = false, emptyHint,
}: {
  title: string;
  icon: any;
  rows: RosterClient[];
  defaultCollapsed?: boolean;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  if (rows.length === 0 && defaultCollapsed) return null; // hide empty collapsed section entirely
  const sorted = sortRows(rows);
  return (
    <div className="rounded-xl bg-white border border-gray-200 mb-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3.5 border-b border-gray-100 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-teal" />
          <h3 className="font-bold text-sm text-navy">{title}</h3>
          <span className="text-[11px] font-semibold text-ink-light bg-gray-100 rounded-full px-2 py-0.5">{rows.length}</span>
        </div>
        {open ? <ChevronDown size={16} className="text-ink-light" /> : <ChevronRight size={16} className="text-ink-light" />}
      </button>
      {open && (
        <div className="p-3 space-y-1.5">
          {sorted.length === 0 ? (
            <p className="text-xs text-ink-light py-3 text-center">{emptyHint || "Nothing here."}</p>
          ) : (
            sorted.map((c) => <Row key={c.id} c={c} />)
          )}
        </div>
      )}
    </div>
  );
}

export function CleanupSections({
  continueCleanup, completed, stripeRecon, bsCleanup,
}: {
  continueCleanup: RosterClient[];
  completed: RosterClient[];
  stripeRecon: RosterClient[];
  bsCleanup: RosterClient[];
}) {
  return (
    <div>
      <Section title="Continue cleanup" icon={RefreshCw} rows={continueCleanup} emptyHint="No cleanups in progress." />
      <Section title="Stripe recon" icon={CreditCard} rows={stripeRecon} emptyHint="No pending Stripe connections." />
      <Section title="Balance Sheet cleanup" icon={Scale} rows={bsCleanup} emptyHint="No production clients awaiting BS." />
      <Section title="Open a completed cleanup" icon={Sparkles} rows={completed} defaultCollapsed emptyHint="No completed files." />
    </div>
  );
}
