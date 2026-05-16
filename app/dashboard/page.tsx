import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import Link from "next/link";
import { Plus, ArrowRight, MoreVertical, Zap, CheckCircle2, Flag, TrendingUp, FilePlus2, Shuffle, CreditCard, Receipt } from "lucide-react";

export default async function DashboardPage() {
  const supabase = await createServerSupabase();

  const { data: stats } = await supabase.from("dashboard_stats").select("*").single();
  const { data: jobs } = await supabase.from("active_jobs_view").select("*").limit(10);

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const statCards = [
    { label: "Active Jobs", value: stats?.active_jobs ?? 0, color: "#2D7A75", icon: Zap },
    { label: "Completed This Week", value: stats?.completed_this_week ?? 0, color: "#10B981", icon: CheckCircle2 },
    { label: "Flagged for Lisa", value: stats?.flagged_for_lisa ?? 0, color: "#F59E0B", icon: Flag },
    {
      label: "Avg Duration",
      value: stats?.avg_duration_seconds ? `${Math.round(stats.avg_duration_seconds / 60)}m` : "—",
      color: "#0F1F2E",
      icon: TrendingUp,
    },
  ];

  return (
    <AppShell>
      <TopBar
        title="Dashboard"
        subtitle={`${today} — Welcome back`}
        actions={
          <Link
            href="/jobs/new"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            <Plus size={16} />
            New Cleanup Job
          </Link>
        }
      />

      <div className="px-8 py-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {statCards.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="p-5 rounded-xl bg-white border border-gray-200">
                <div className="flex items-start justify-between mb-3">
                  <div
                    className="p-2 rounded-lg"
                    style={{ backgroundColor: `${s.color}15` }}
                  >
                    <Icon size={18} style={{ color: s.color }} />
                  </div>
                </div>
                <div className="text-2xl font-bold tracking-tight text-navy">{s.value}</div>
                <div className="text-sm mt-1 text-ink-slate">{s.label}</div>
              </div>
            );
          })}
        </div>

        {/* Workflow guide */}
        <div className="rounded-xl bg-white border border-gray-200 mb-6 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-teal-lighter to-blue-50">
            <h2 className="text-base font-bold text-navy">The IronBooks Cleanup Workflow</h2>
            <p className="text-xs text-ink-slate mt-0.5">
              Four sequential steps to take a painter's QBO from messy to clean. Each step hands off to the next.
            </p>
          </div>
          <div className="grid grid-cols-4 divide-x divide-gray-100">
            {[
              {
                num: 1, label: "COA Cleanup", icon: FilePlus2, href: "/jobs/new",
                desc: "Align chart of accounts to the IronBooks master template",
                tag: "Required", tagColor: "#2D7A75",
              },
              {
                num: 2, label: "Reclassify", icon: Shuffle, href: "/reclass/new",
                desc: "AI categorizes every transaction against the new COA",
                tag: "Required", tagColor: "#2D7A75",
              },
              {
                num: 3, label: "Stripe Recon", icon: CreditCard, href: "/stripe-recon/new",
                desc: "Match Stripe deposits to invoices + split out fees & tax",
                tag: "If applicable", tagColor: "#7C3AED",
              },
              {
                num: 4, label: "Bank Rules", icon: Receipt, href: "/rules/new",
                desc: "Auto-generate rules so future transactions categorize themselves",
                tag: "Recommended", tagColor: "#0891B2",
              },
            ].map((s) => {
              const Icon = s.icon;
              return (
                <Link
                  key={s.num}
                  href={s.href}
                  className="p-4 hover:bg-teal-lighter transition-colors group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className="rounded-full flex items-center justify-center font-bold text-xs w-6 h-6 bg-gray-100 text-ink-slate group-hover:bg-teal group-hover:text-white transition-colors">
                      {s.num}
                    </div>
                    <Icon size={16} className="text-ink-slate group-hover:text-teal transition-colors" />
                    <span
                      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ml-auto"
                      style={{ backgroundColor: `${s.tagColor}15`, color: s.tagColor }}
                    >
                      {s.tag}
                    </span>
                  </div>
                  <div className="font-bold text-sm text-navy mb-1">{s.label}</div>
                  <div className="text-xs text-ink-slate leading-snug">{s.desc}</div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Active jobs */}
        <div className="rounded-xl bg-white border border-gray-200">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
            <h2 className="text-base font-bold text-navy">Active Jobs</h2>
            <Link href="/history" className="text-sm font-semibold flex items-center gap-1 text-teal">
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {!jobs || jobs.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm text-ink-slate mb-4">No active jobs yet.</p>
              <Link
                href="/jobs/new"
                className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:text-teal-dark"
              >
                Start your first cleanup <ArrowRight size={14} />
              </Link>
            </div>
          ) : (
            <div>
              {jobs.map((job, i) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}/review`}
                  className="flex items-center px-5 py-4 hover:bg-teal-lighter transition-colors"
                  style={{
                    borderBottom: i < jobs.length - 1 ? "1px solid #F1F5F9" : "none",
                  }}
                >
                  <div className="rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0 mr-4 w-9 h-9 bg-teal-light text-teal">
                    {job.client_name?.charAt(0) || "?"}
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold text-sm text-navy">{job.client_name}</div>
                    <div className="text-xs mt-0.5 text-ink-slate">
                      {job.bookkeeper_name} • {job.jurisdiction} {job.state_province}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-teal-light text-teal capitalize">
                      {job.status?.replace("_", " ")}
                    </span>
                    {job.flagged_for_lisa && (
                      <Flag size={14} className="text-yellow-500" />
                    )}
                    <MoreVertical size={16} className="text-ink-light" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
