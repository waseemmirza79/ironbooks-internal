"use client";

import { useState } from "react";
import {
  CheckCircle2, ChevronRight, CreditCard, ExternalLink, Phone,
  ArrowUpCircle, FileText, AlertTriangle, XCircle, Loader2, Star,
} from "lucide-react";
import type { ServiceTier, TierConfig } from "./page";
import { TIERS, INCLUDED_FEATURES } from "./page";

interface Props {
  clientLinkId: string;
  clientName: string;
  tier: ServiceTier | null;
  billingStart: string | null;
  stripeCustomerId: string | null;
  coachingCallLink: string | null;
  cancelRequestAt: string | null;
  cancelRequestNote: string | null;
  impersonating: boolean;
}

const TIER_COLORS: Record<string, string> = {
  teal:   "bg-teal/10 text-teal border-teal/20",
  blue:   "bg-blue-50 text-blue-700 border-blue-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  navy:   "bg-navy/10 text-navy border-navy/20",
};

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function BillingClient({
  clientLinkId,
  clientName,
  tier,
  billingStart,
  stripeCustomerId,
  coachingCallLink,
  cancelRequestAt,
  cancelRequestNote,
  impersonating,
}: Props) {
  const currentTier = tier ? TIERS.find((t) => t.key === tier) || null : null;
  const currentIdx = tier ? TIERS.findIndex((t) => t.key === tier) : -1;
  const nextTier: TierConfig | null = currentIdx >= 0 && currentIdx < TIERS.length - 1
    ? TIERS[currentIdx + 1]
    : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Account</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Billing & Plan</h1>
        {impersonating && (
          <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
            Preview mode — actions are disabled while impersonating
          </div>
        )}
      </div>

      {/* ── Current plan ── */}
      <CurrentPlanCard
        tier={currentTier}
        billingStart={billingStart}
      />

      {/* ── What's included ── */}
      <WhatIsIncludedCard />

      {/* ── Book a coaching call ── */}
      <CoachingCallCard
        coachingCallLink={coachingCallLink}
        impersonating={impersonating}
      />

      {/* ── Upgrade ── */}
      {nextTier && currentTier && (
        <UpgradeCard
          currentTier={currentTier}
          nextTier={nextTier}
          clientName={clientName}
          impersonating={impersonating}
        />
      )}

      {/* ── Receipts ── */}
      <ReceiptsCard
        stripeCustomerId={stripeCustomerId}
        impersonating={impersonating}
      />

      {/* ── Cancel request ── */}
      <CancelRequestCard
        clientLinkId={clientLinkId}
        cancelRequestAt={cancelRequestAt}
        cancelRequestNote={cancelRequestNote}
        impersonating={impersonating}
      />
    </div>
  );
}

// ─── Current plan card ───────────────────────────────────────────────────────

function CurrentPlanCard({ tier, billingStart }: { tier: TierConfig | null; billingStart: string | null }) {
  if (!tier) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <Star size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Your plan</h2>
        </div>
        <p className="text-sm text-ink-slate mt-3">
          Your service tier hasn't been set up yet. Your Ironbooks team will confirm your plan details.
          Reach out to{" "}
          <a href="mailto:admin@ironbooks.com" className="text-teal underline underline-offset-2">
            admin@ironbooks.com
          </a>{" "}
          with any questions.
        </p>
      </div>
    );
  }

  const colorClass = TIER_COLORS[tier.color] || TIER_COLORS.navy;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Your plan</h2>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${colorClass}`}>
          {tier.name}
        </span>
      </div>
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-end gap-2">
          {tier.monthlyFee !== null ? (
            <>
              <span className="text-3xl font-black text-navy">{fmt(tier.monthlyFee)}</span>
              <span className="text-sm text-ink-slate mb-1">/month · 12-month commitment</span>
            </>
          ) : (
            <span className="text-2xl font-black text-navy">Custom pricing</span>
          )}
        </div>
        <p className="text-sm text-ink-slate">{tier.tagline}</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Revenue cap</dt>
            <dd className="font-semibold text-navy mt-0.5">{tier.revenueCap}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Onboarding call</dt>
            <dd className="font-semibold text-navy mt-0.5">{tier.onboardingCall}</dd>
          </div>
          {billingStart && (
            <div className="col-span-2">
              <dt className="text-[10px] uppercase tracking-wider text-ink-light font-semibold">Member since</dt>
              <dd className="font-semibold text-navy mt-0.5">{fmtDate(billingStart)}</dd>
            </div>
          )}
        </dl>
        {tier.key === "insight" && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800">
            <strong>Tier 1 participation reminder:</strong> To keep Insight pricing available, we ask
            that you promote Ironbooks once per quarter via your email list or social media using our
            templates. Send a link or screenshot to{" "}
            <a href="mailto:admin@ironbooks.com" className="underline">admin@ironbooks.com</a>.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── What's included ─────────────────────────────────────────────────────────

function WhatIsIncludedCard() {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <CheckCircle2 size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">What's included</h2>
      </div>
      <ul className="px-6 py-5 space-y-2">
        {INCLUDED_FEATURES.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-navy">
            <CheckCircle2 size={14} className="text-teal flex-shrink-0 mt-0.5" />
            {f}
          </li>
        ))}
      </ul>
      <div className="px-6 pb-5 text-xs text-ink-slate">
        All tiers include a 12-month commitment. Questions about your scope?{" "}
        <a href="mailto:admin@ironbooks.com" className="text-teal underline underline-offset-2">
          Email us
        </a>
        .
      </div>
    </div>
  );
}

// ─── Coaching call ────────────────────────────────────────────────────────────

function CoachingCallCard({
  coachingCallLink,
  impersonating,
}: {
  coachingCallLink: string | null;
  impersonating: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Phone size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Book a coaching call</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-black text-navy">$150 <span className="text-sm font-normal text-ink-slate">/ 30 min</span></div>
            <p className="text-sm text-ink-slate mt-1">
              A focused 1:1 review of your numbers with your bookkeeping coach. Covers your P&amp;L,
              margin, cash position — whatever you want to dig into.
            </p>
          </div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-ink-slate">
          <strong className="text-navy">What to expect:</strong> Your coach will review your most recent
          month before the call. Come with your top 2–3 questions and leave with a clear action plan.
        </div>
        {coachingCallLink ? (
          impersonating ? (
            <div className="text-xs text-ink-slate italic">Payment link hidden during impersonation.</div>
          ) : (
            <a
              href={coachingCallLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
            >
              Book & pay now
              <ExternalLink size={13} />
            </a>
          )
        ) : (
          <a
            href="mailto:admin@ironbooks.com?subject=Book%20a%20coaching%20call"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            Request a session
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Upgrade ──────────────────────────────────────────────────────────────────

function UpgradeCard({
  currentTier,
  nextTier,
  clientName,
  impersonating,
}: {
  currentTier: TierConfig;
  nextTier: TierConfig;
  clientName: string;
  impersonating: boolean;
}) {
  const priceDiff =
    nextTier.monthlyFee !== null && currentTier.monthlyFee !== null
      ? nextTier.monthlyFee - currentTier.monthlyFee
      : null;

  const subject = encodeURIComponent(`Upgrade request — ${clientName} → ${nextTier.name}`);
  const body = encodeURIComponent(
    `Hi,\n\nI'd like to upgrade my Ironbooks plan from ${currentTier.name} to ${nextTier.name}.\n\nPlease let me know next steps.\n\nThanks,\n${clientName}`
  );

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <ArrowUpCircle size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Upgrade your plan</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-bold text-navy">{nextTier.name}</div>
            <div className="text-xs text-ink-slate mt-0.5">{nextTier.tagline}</div>
            <div className="text-xs text-ink-slate mt-1">Revenue cap: <strong>{nextTier.revenueCap}</strong></div>
          </div>
          <div className="text-right flex-shrink-0">
            {nextTier.monthlyFee !== null ? (
              <>
                <div className="text-xl font-black text-navy">{fmt(nextTier.monthlyFee)}<span className="text-xs font-normal text-ink-slate">/mo</span></div>
                {priceDiff !== null && (
                  <div className="text-xs text-ink-slate">+{fmt(priceDiff)}/mo from current</div>
                )}
              </>
            ) : (
              <div className="text-sm font-bold text-navy">Custom pricing</div>
            )}
          </div>
        </div>
        <p className="text-sm text-ink-slate">
          Ready to unlock more capacity? Send us a quick note and we'll confirm the upgrade and
          adjust your billing in the next cycle.
        </p>
        {impersonating ? (
          <div className="text-xs text-ink-slate italic">Email link hidden during impersonation.</div>
        ) : (
          <a
            href={`mailto:admin@ironbooks.com?subject=${subject}&body=${body}`}
            className="inline-flex items-center gap-2 border-2 border-navy text-navy hover:bg-navy hover:text-white text-sm font-bold px-5 py-2.5 rounded-lg transition-colors"
          >
            Request upgrade
            <ChevronRight size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Receipts ─────────────────────────────────────────────────────────────────

function ReceiptsCard({
  stripeCustomerId,
  impersonating,
}: {
  stripeCustomerId: string | null;
  impersonating: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <FileText size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Receipts & invoices</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <p className="text-sm text-ink-slate">
          Access your payment history and download PDF receipts for any invoice.
        </p>
        {impersonating ? (
          <div className="text-xs text-ink-slate italic">Links hidden during impersonation.</div>
        ) : stripeCustomerId ? (
          <CustomerPortalButton clientLinkId={""} hasStripeId />
        ) : (
          <a
            href="mailto:admin@ironbooks.com?subject=Request%20for%20receipts"
            className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:underline"
          >
            Email us for a copy of your invoices
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    </div>
  );
}

function CustomerPortalButton({ hasStripeId }: { clientLinkId: string; hasStripeId: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasStripeId) return null;

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/billing/customer-portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open billing portal");
      window.location.href = data.url;
    } catch (e: any) {
      setError(e.message || "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={open}
        disabled={loading}
        className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-navy disabled:opacity-50"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
        View payment history
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

// ─── Cancel request ───────────────────────────────────────────────────────────

function CancelRequestCard({
  clientLinkId,
  cancelRequestAt,
  cancelRequestNote,
  impersonating,
}: {
  clientLinkId: string;
  cancelRequestAt: string | null;
  cancelRequestNote: string | null;
  impersonating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(!!cancelRequestAt);
  const [submittedAt, setSubmittedAt] = useState(cancelRequestAt);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (impersonating) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/billing/cancel-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setSubmitted(true);
      setSubmittedAt(new Date().toISOString());
      setOpen(false);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <XCircle size={16} className="text-ink-slate" />
          <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Cancel request received</h2>
        </div>
        <div className="px-6 py-5 space-y-2">
          <div className="flex items-start gap-2.5 text-sm text-emerald-700">
            <CheckCircle2 size={15} className="flex-shrink-0 mt-0.5" />
            <span>
              We received your cancellation request
              {submittedAt ? ` on ${fmtDate(submittedAt)}` : ""}.
              Someone from our team will be in touch within 1–2 business days to confirm
              and walk you through the transition.
            </span>
          </div>
          {cancelRequestNote && (
            <div className="text-xs text-ink-slate italic mt-2">
              Your note: "{cancelRequestNote}"
            </div>
          )}
          <p className="text-xs text-ink-slate pt-2">
            Please note: submitting this form does not cancel your account automatically.
            Your 12-month commitment and billing continue until we confirm the cancellation
            in writing. See your agreement for full terms.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <XCircle size={16} className="text-ink-slate" />
        <h2 className="text-sm font-bold text-navy uppercase tracking-wider">Cancel subscription</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        {!open ? (
          <>
            <p className="text-sm text-ink-slate">
              Need to step away? Submit a cancel request and your Ironbooks manager will reach
              out within 1–2 business days to discuss options and next steps.
            </p>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                Submitting a request does not cancel your account or stop billing. Your 12-month
                commitment terms apply. We're happy to discuss your situation before any final
                decision is made.
              </span>
            </div>
            <button
              onClick={() => setOpen(true)}
              className="text-sm text-ink-slate hover:text-red-600 underline underline-offset-2"
            >
              Request cancellation
            </button>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-slate">
              Help us understand — what's not working? Your feedback goes directly to your manager.
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional: share what's behind this decision (e.g. budget, the service isn't a fit, closing the business)…"
              rows={4}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy placeholder:text-ink-light resize-none focus:outline-none focus:border-navy"
            />
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This notifies your Ironbooks manager. It does <strong>not</strong> cancel your account
                or stop billing. Your manager will be in touch within 1–2 business days.
              </span>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex items-center gap-3">
              <button
                onClick={submit}
                disabled={loading || impersonating}
                className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                Submit cancel request
              </button>
              <button
                onClick={() => { setOpen(false); setNote(""); setError(null); }}
                className="text-sm text-ink-slate hover:text-navy"
              >
                Never mind
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
