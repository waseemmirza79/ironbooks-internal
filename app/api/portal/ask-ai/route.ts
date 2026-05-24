import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolvePortalContext, PortalAccessError } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchProfitAndLoss } from "@/lib/qbo-reports";
import { fetchAllAccounts } from "@/lib/qbo";
import { fetchOpenInvoices } from "@/lib/qbo-balance-sheet";
import {
  fetchOpenBills,
  fetchBalanceSheetSummary,
  summarizeBanks,
  thisMonthRange,
  lastMonthRange,
  ytdRange,
} from "@/lib/portal-data";
import {
  buildPeriodSnapshot,
  buildBalanceSheetSnapshot,
  summarizeAR,
  summarizeAP,
  buildUserMessage,
  PORTAL_AI_SYSTEM_PROMPT,
  type PortalAiContext,
} from "@/lib/portal-ai";

/**
 * POST /api/portal/ask-ai
 *
 * Streaming Claude response to a client's question about their finances.
 * The portal context (user → client_link → QBO token) is resolved
 * server-side, so the client can never ask about anyone else's books.
 *
 * Request body:
 *   {
 *     question: string,                    // current user message
 *     history?: { role: "user"|"assistant"; content: string }[]  // prior turns
 *   }
 *
 * Response: Server-Sent Events with text chunks. Standard Anthropic
 * streaming format adapted to plain text deltas for our chat UI to
 * consume incrementally.
 *
 * Rate limit: DEFAULT_DAILY_LIMIT messages/user/day, tracked in
 * portal_ai_usage. Soft limit — when hit, returns 429 with a friendly
 * message that explains the reset.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-opus-4-7";
const DEFAULT_DAILY_LIMIT = 50;
const MAX_INPUT_TOKENS_BUDGET = 80_000; // soft guard against runaway context
const MAX_HISTORY_TURNS = 12;            // keep the most recent N user+assistant pairs

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  // 1. Resolve who's asking
  let ctx;
  try {
    ctx = await resolvePortalContext();
  } catch (err) {
    if (err instanceof PortalAccessError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "no_session" ? 401 : 403 }
      );
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  // 2. Parse + validate
  const body = await request.json().catch(() => ({} as any));
  const question = (body.question || "").toString().trim();
  if (!question) {
    return NextResponse.json({ error: "Question is required" }, { status: 400 });
  }
  if (question.length > 2000) {
    return NextResponse.json(
      { error: "Question is too long — try keeping it under a paragraph." },
      { status: 400 }
    );
  }
  const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(body.history)
    ? body.history.slice(-MAX_HISTORY_TURNS * 2)
    : [];

  // 3. Rate limit check
  const service = createServiceSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await service
    .from("portal_ai_usage" as any)
    .select("message_count")
    .eq("user_id", ctx.userId)
    .eq("usage_date", today)
    .maybeSingle();
  const currentCount = (usage as any)?.message_count ?? 0;
  if (currentCount >= DEFAULT_DAILY_LIMIT) {
    return NextResponse.json(
      {
        error: `You've used your ${DEFAULT_DAILY_LIMIT} questions for today — the count resets at midnight UTC. If you need to dig deeper, reach out to your bookkeeper.`,
        code: "rate_limited",
      },
      { status: 429 }
    );
  }

  // 4. Build the financial context (parallel fetch)
  let aiContext: PortalAiContext;
  try {
    const tm = thisMonthRange();
    const lm = lastMonthRange();
    const yr = ytdRange();
    const [currentPL, lastPL, ytdPL, accounts, invoices, bills, bs] = await Promise.all([
      fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, tm.start, tm.end),
      fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, lm.start, lm.end),
      fetchProfitAndLoss(ctx.qboRealmId, ctx.accessToken, yr.start, yr.end),
      fetchAllAccounts(ctx.qboRealmId, ctx.accessToken),
      fetchOpenInvoices(ctx.qboRealmId, ctx.accessToken),
      fetchOpenBills(ctx.qboRealmId, ctx.accessToken),
      fetchBalanceSheetSummary(ctx.qboRealmId, ctx.accessToken),
    ]);
    const banks = summarizeBanks(accounts);
    aiContext = {
      clientName: ctx.clientName,
      asOfDate: tm.end,
      currentMonth: buildPeriodSnapshot(tm.start, tm.end, currentPL),
      lastMonth: buildPeriodSnapshot(lm.start, lm.end, lastPL),
      ytd: buildPeriodSnapshot(yr.start, yr.end, ytdPL),
      balanceSheet: buildBalanceSheetSnapshot(bs),
      cashOnHand: {
        totalBank: Math.round(banks.totalCashOnHand),
        totalCreditCardDebt: Math.round(banks.totalCreditCardDebt),
        accounts: banks.accounts.map((a) => ({
          name: a.name,
          balance: Math.round(a.balance),
          type: a.type,
        })),
      },
      openAR: summarizeAR(invoices),
      openAP: summarizeAP(bills),
    };
  } catch (err: any) {
    return NextResponse.json(
      { error: `Couldn't load your financial data — please try again. (${err?.message || "unknown"})` },
      { status: 500 }
    );
  }

  // 5. Build the Anthropic message array. Prior turns first, then the
  //    current question with the context block prepended.
  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...history.map((m) => ({
      role: m.role,
      content: m.content.slice(0, 5000), // trim defensive
    })),
    {
      role: "user",
      content: buildUserMessage(question, aiContext),
    },
  ];

  // 6. Stream the response. Anthropic SDK gives us a token stream; we
  //    convert it to a Server-Sent Events response for the client UI.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let inputTokens = 0;
      let outputTokens = 0;

      const send = (event: string, data: any) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        const claudeStream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 1500,
          system: PORTAL_AI_SYSTEM_PROMPT,
          messages,
        });

        for await (const event of claudeStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send("delta", { text: event.delta.text });
          } else if (event.type === "message_start") {
            inputTokens = event.message.usage?.input_tokens || 0;
          } else if (event.type === "message_delta") {
            outputTokens = event.usage?.output_tokens || outputTokens;
          }
        }

        send("done", { input_tokens: inputTokens, output_tokens: outputTokens });
      } catch (err: any) {
        send("error", {
          message: err?.message || "AI response failed",
        });
      } finally {
        controller.close();

        // Best-effort usage tally — runs after the stream is closed so it
        // doesn't slow down the user-visible response.
        try {
          // Upsert pattern: try insert; on conflict (user_id, usage_date) bump count.
          const { data: existing } = await service
            .from("portal_ai_usage" as any)
            .select("id, message_count, input_tokens, output_tokens")
            .eq("user_id", ctx.userId)
            .eq("usage_date", today)
            .maybeSingle();
          if (existing) {
            await service
              .from("portal_ai_usage" as any)
              .update({
                message_count: ((existing as any).message_count || 0) + 1,
                input_tokens: ((existing as any).input_tokens || 0) + inputTokens,
                output_tokens: ((existing as any).output_tokens || 0) + outputTokens,
                updated_at: new Date().toISOString(),
              } as any)
              .eq("id", (existing as any).id);
          } else {
            await service.from("portal_ai_usage" as any).insert({
              client_link_id: ctx.clientLinkId,
              user_id: ctx.userId,
              usage_date: today,
              message_count: 1,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            } as any);
          }
        } catch (telemetryErr: any) {
          console.warn("[portal-ai] usage tally failed:", telemetryErr?.message);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
