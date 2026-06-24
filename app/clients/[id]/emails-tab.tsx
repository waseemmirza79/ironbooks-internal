"use client";

import { Mail } from "lucide-react";
import type { EmailHistoryRow } from "@/lib/internal-client-profile";

const STATUS_STYLE: Record<string, string> = {
  sent: "bg-slate-100 text-slate-700",
  delivered: "bg-green-50 text-green-700",
  pending: "bg-amber-50 text-amber-700",
  bounced: "bg-red-50 text-red-700",
  complained: "bg-red-50 text-red-700",
  failed: "bg-red-50 text-red-700",
};

const TYPE_LABEL: Record<string, string> = {
  stripe_connect: "Stripe connect request",
  bs_statements: "Statement request",
};

function fmtType(t: string): string {
  return TYPE_LABEL[t] || t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function EmailsTab({ emails }: { emails: EmailHistoryRow[] }) {
  if (!emails || emails.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <Mail size={22} className="mx-auto text-ink-light" />
        <p className="mt-2 text-sm font-semibold text-navy">No emails sent yet</p>
        <p className="text-xs text-ink-slate mt-0.5">
          Branded emails SNAP sends to this client — connect requests, statement requests — show
          here with their delivery status.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
        <Mail size={15} className="text-teal" />
        <h3 className="text-sm font-bold text-navy">Email history</h3>
        <span className="text-[11px] text-ink-light">({emails.length})</span>
      </div>
      <div className="divide-y divide-gray-100">
        {emails.map((e) => {
          const badge = STATUS_STYLE[e.status] || "bg-slate-100 text-slate-700";
          return (
            <div key={e.id} className="px-5 py-3 hover:bg-teal-lighter/30 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-navy truncate">
                    {e.subject || fmtType(e.emailType)}
                  </div>
                  <div className="text-xs text-ink-slate mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="inline-flex items-center gap-1">
                      <Mail size={11} /> {e.toAddress}
                    </span>
                    <span className="text-ink-light">·</span>
                    <span>{fmtType(e.emailType)}</span>
                    <span className="text-ink-light">·</span>
                    <span>{new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  {e.error && (
                    <div className="text-[11px] text-red-600 mt-1 truncate">{e.error}</div>
                  )}
                </div>
                <span
                  className={`flex-shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${badge}`}
                >
                  {e.status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
