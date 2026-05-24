import { Sparkles, ArrowLeft } from "lucide-react";
import Link from "next/link";

/**
 * AI Q&A — placeholder. Day 6 wires Claude streaming + QBO context.
 */
export default function AskAiPlaceholder() {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Your AI bookkeeper</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Ask anything about your finances</h1>
      </div>

      <div className="bg-gradient-to-br from-teal/10 to-teal/5 border-2 border-teal/30 rounded-2xl p-8 text-center">
        <Sparkles size={32} className="text-teal-dark mx-auto mb-3" />
        <h2 className="font-bold text-navy">AI assistant launching soon</h2>
        <p className="text-sm text-ink-slate mt-2 max-w-md mx-auto">
          We're finishing the connection to your live books so the AI can answer questions like
          "Why did costs go up?" or "Can I afford another hire?" with real data — not generic
          advice. Expect this within a few days.
        </p>
        <Link href="/portal" className="inline-flex items-center gap-1 mt-4 text-xs font-semibold text-teal-dark hover:underline">
          <ArrowLeft size={11} /> Back to overview
        </Link>
      </div>
    </div>
  );
}
