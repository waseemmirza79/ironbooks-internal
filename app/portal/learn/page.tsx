import { GraduationCap, ArrowLeft } from "lucide-react";
import Link from "next/link";

/**
 * Learn — placeholder. Day 7 ships the table-driven LMS with Vimeo embeds
 * + PDF downloads.
 */
export default function LearnPlaceholder() {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Financial literacy</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Learn how to read your books</h1>
      </div>

      <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-8 text-center">
        <GraduationCap size={32} className="text-teal-dark mx-auto mb-3" />
        <h2 className="font-bold text-navy">Video library coming soon</h2>
        <p className="text-sm text-ink-slate mt-2 max-w-md mx-auto">
          Short videos and downloads from your Ironbooks team — covering how to read a P&L,
          cash flow basics, tax planning, and more. Launching with the AI assistant.
        </p>
        <Link href="/portal" className="inline-flex items-center gap-1 mt-4 text-xs font-semibold text-teal-dark hover:underline">
          <ArrowLeft size={11} /> Back to overview
        </Link>
      </div>
    </div>
  );
}
