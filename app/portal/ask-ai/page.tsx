import { tryResolvePortalContext } from "@/lib/portal-context";
import { PortalErrorState } from "../error-state";
import { AskAiClient } from "./ask-ai-client";

export const dynamic = "force-dynamic";

/**
 * AI Q&A — streaming Claude with this client's QBO context.
 *
 * Server component just gates the access; the client component holds the
 * conversation state (per-session only, no DB persistence in MVP) and
 * talks to /api/portal/ask-ai for streaming responses.
 */
export default async function AskAiPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  return <AskAiClient />;
}
