import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  UF_AI_SYSTEM_PROMPT,
  buildUfAiUserMessage,
  type UfAiResult,
} from "@/lib/uf-ai-prompt";
import { getValidToken } from "@/lib/qbo";
import {
  fetchTransactionListAsCsv,
  findAccountsReceivableAccountId,
  findUndepositedFundsAccountIdForUfAi,
} from "@/lib/qbo-uf-ai";

export const dynamic = "force-dynamic";
// CSV analysis can take 30-60s on large reports — give it 90s headroom.
export const maxDuration = 90;

const MODEL = "claude-opus-4-7";

/**
 * POST /api/uf-ai/analyze
 *
 * AI-driven Undeposited Funds reconciliation. The bookkeeper uploads two
 * CSVs (AR transaction report + UF transaction report) and Claude returns
 * a structured reconciliation with open items, matched payments, journal
 * entries, balance verification, and remediation instructions.
 *
 * Unblocks UF cleanup work when QBO tokens are dead — the bookkeeper
 * can still export CSVs by logging directly into the client's QBO via
 * QBOA (firm-level membership stays alive even when our refresh tokens
 * die), and run them through this tool to plan the cleanup.
 *
 * Body (JSON):
 *   {
 *     client_link_id: string,
 *     ar_csv_text: string,
 *     uf_csv_text: string
 *   }
 *
 * Returns the structured UfAiResult JSON directly, plus the raw Claude
 * response stored in audit_log for debugging if anything looks off.
 */
export async function POST(request: Request) {
  // Auth gate — admin/lead/bookkeeper only. Clients should never hit this.
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (!role || role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parse + validate input. Two input modes:
  //   1. CSV mode — bookkeeper pasted/uploaded the two transaction CSVs
  //   2. QBO mode — pull both reports live from the client's QBO via API
  //      (defaulted to the trailing 12 months if no date range provided)
  let body: {
    client_link_id?: string;
    source?: "csv" | "qbo";
    ar_csv_text?: string;
    uf_csv_text?: string;
    start_date?: string;
    end_date?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { client_link_id } = body;
  const source = body.source || (body.ar_csv_text ? "csv" : "qbo");
  if (!client_link_id) {
    return NextResponse.json(
      { error: "Missing required field: client_link_id" },
      { status: 400 }
    );
  }

  // Resolve client + realm
  const { data: client } = await service
    .from("client_links")
    .select("client_name, qbo_realm_id")
    .eq("id", client_link_id)
    .single();
  const clientName = (client as any)?.client_name || null;
  const realmId = (client as any)?.qbo_realm_id || null;

  // Source-specific input prep
  let arCsv: string;
  let ufCsv: string;
  let qboPullMeta: any = null;

  if (source === "qbo") {
    if (!realmId) {
      return NextResponse.json(
        { error: "This client has no QuickBooks connection. Use the CSV upload option instead." },
        { status: 400 }
      );
    }

    let accessToken: string;
    try {
      accessToken = await getValidToken(client_link_id, service as any);
    } catch (err: any) {
      return NextResponse.json(
        {
          error:
            "QuickBooks authorization for this client has expired. Reconnect from the client profile, or paste CSV exports instead.",
          code: "qbo_token_dead",
        },
        { status: 502 }
      );
    }

    // Default: trailing 12 months. Bookkeeper can override via body.
    const today = new Date().toISOString().slice(0, 10);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const defaultStart = oneYearAgo.toISOString().slice(0, 10);
    const startDate = body.start_date || defaultStart;
    const endDate = body.end_date || today;

    // Resolve account IDs + pull both reports in parallel
    const [arAccountId, ufAccountId] = await Promise.all([
      findAccountsReceivableAccountId(realmId, accessToken).catch(() => null),
      findUndepositedFundsAccountIdForUfAi(realmId, accessToken).catch(() => null),
    ]);

    if (!arAccountId) {
      return NextResponse.json(
        { error: "Couldn't find an Accounts Receivable account in this client's QBO." },
        { status: 422 }
      );
    }
    if (!ufAccountId) {
      return NextResponse.json(
        { error: "Couldn't find an Undeposited Funds account in this client's QBO." },
        { status: 422 }
      );
    }

    try {
      const [arResult, ufResult] = await Promise.all([
        fetchTransactionListAsCsv(realmId, accessToken, arAccountId, startDate, endDate),
        fetchTransactionListAsCsv(realmId, accessToken, ufAccountId, startDate, endDate),
      ]);
      arCsv = arResult.csv;
      ufCsv = ufResult.csv;
      qboPullMeta = {
        ar_account_id: arAccountId,
        uf_account_id: ufAccountId,
        ar_rows: arResult.rowCount,
        uf_rows: ufResult.rowCount,
        date_range: { start: startDate, end: endDate },
      };
    } catch (err: any) {
      return NextResponse.json(
        { error: `QBO report fetch failed: ${err?.message || err}` },
        { status: 502 }
      );
    }

    if (arCsv.length < 50 && ufCsv.length < 50) {
      return NextResponse.json(
        {
          error:
            "QBO returned no transactions in the date range. Try widening the range or paste CSV exports.",
        },
        { status: 422 }
      );
    }
  } else {
    // CSV mode — both CSVs are required from the request body
    if (!body.ar_csv_text || !body.uf_csv_text) {
      return NextResponse.json(
        { error: "Missing required fields: ar_csv_text, uf_csv_text" },
        { status: 400 }
      );
    }
    if (body.ar_csv_text.length < 50 || body.uf_csv_text.length < 50) {
      return NextResponse.json(
        { error: "CSVs look empty — did you paste the right files?" },
        { status: 400 }
      );
    }
    arCsv = body.ar_csv_text;
    ufCsv = body.uf_csv_text;
  }

  // Initialize Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }
  const anthropic = new Anthropic({ apiKey });

  const userMessage = buildUfAiUserMessage(arCsv, ufCsv, clientName);

  let parsed: UfAiResult | null = null;
  let rawText = "";
  const startedAt = Date.now();

  try {
    // Non-streaming — we need the whole JSON back to parse it, no point
    // in streaming text we'll throw away.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: UF_AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    // Extract text from the content blocks
    rawText = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    // Claude sometimes wraps JSON in ```json fences despite our request.
    // Strip them defensively before parsing.
    let jsonText = rawText.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    }

    try {
      parsed = JSON.parse(jsonText) as UfAiResult;
    } catch (parseErr: any) {
      // Audit-log the failure with the raw text so we can debug what Claude
      // returned instead of valid JSON. Common cause: Claude added a
      // preamble like "Here's the analysis:" that our regex didn't catch.
      await service.from("audit_log").insert({
        event_type: "uf_ai_parse_failed",
        user_id: user.id,
        request_payload: {
          client_link_id,
          error: parseErr.message,
          raw_response_preview: rawText.slice(0, 2000),
        } as any,
      });
      return NextResponse.json(
        {
          error:
            "Claude returned a response we couldn't parse as JSON. The raw response was logged for review.",
          raw_preview: rawText.slice(0, 500),
        },
        { status: 502 }
      );
    }
  } catch (err: any) {
    return NextResponse.json(
      { error: `Claude API call failed: ${err.message || err}` },
      { status: 502 }
    );
  }

  const durationMs = Date.now() - startedAt;

  // Audit log — useful for triaging "Claude got this wrong" complaints
  // later, plus tracks usage. Keep raw text under 50kb to avoid bloating
  // the audit table.
  await service.from("audit_log").insert({
    event_type: "uf_ai_analyze",
    user_id: user.id,
    request_payload: {
      client_link_id,
      client_name: clientName,
      source,
      ar_csv_length: arCsv.length,
      uf_csv_length: ufCsv.length,
      qbo_pull: qboPullMeta,
      duration_ms: durationMs,
      open_items_count: parsed?.open_items?.length ?? 0,
      matches_balance: parsed?.uf_balance?.matches ?? false,
      flags_count: parsed?.flags?.length ?? 0,
      raw_response_sample: rawText.slice(0, 5000),
    } as any,
  });

  return NextResponse.json({
    ok: true,
    result: parsed,
    meta: {
      duration_ms: durationMs,
      model: MODEL,
      source,
      qbo_pull: qboPullMeta,
    },
  });
}
