import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/upgrade-message  { client_link_id, context }
 *
 * Drafts a personalised upgrade message for an Upgrade-Radar candidate. Scrapes
 * the client's matched Grain calls (the cached cross-call overview, else recent
 * call summaries) so the message speaks to what's ACTUALLY going on in their
 * business — not a generic pitch. Falls back to a growth-numbers-only message
 * when there are no matched calls. Admin/lead/billing_admin only.
 *
 * context (from the radar row): { currentTier, currentPay, targetTier,
 * targetPrice, runRate, marginPct } — human-readable strings/numbers.
 */
const MODEL = "claude-opus-4-8";

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "billing_admin"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const clientLinkId = body.client_link_id;
  const ctx = body.context || {};
  if (!clientLinkId) return NextResponse.json({ error: "client_link_id required" }, { status: 400 });

  const { data: cl } = await service
    .from("client_links")
    .select("id, client_name, legal_business_name, contact_first_name")
    .eq("id", clientLinkId)
    .single();
  if (!cl) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const company = (cl as any).legal_business_name || (cl as any).client_name || "the client";
  const firstName = ((cl as any).contact_first_name || "").trim() || null;

  // ── Grain context ─────────────────────────────────────────────────────────
  // Prefer the cached cross-call overview; else stitch recent call summaries.
  let grainContext = "";
  let recordingCount = 0;
  try {
    const { data: ov } = await (service as any)
      .from("grain_call_overviews")
      .select("overview, recording_count")
      .eq("client_link_id", clientLinkId)
      .maybeSingle();
    if (ov?.overview) {
      grainContext = String(ov.overview);
      recordingCount = ov.recording_count || 0;
    }
    if (!grainContext) {
      const { data: matches } = await (service as any)
        .from("grain_recording_matches")
        .select("recording_id")
        .eq("client_link_id", clientLinkId);
      const ids = ((matches as any[]) || []).map((m) => m.recording_id);
      recordingCount = ids.length;
      if (ids.length) {
        const { data: recs } = await (service as any)
          .from("grain_recordings")
          .select("title, summary, action_items, start_datetime")
          .in("id", ids)
          .order("start_datetime", { ascending: false })
          .limit(6);
        grainContext = ((recs as any[]) || [])
          .map((r) => {
            const when = r.start_datetime ? new Date(r.start_datetime).toISOString().slice(0, 10) : "";
            const ai = Array.isArray(r.action_items) ? r.action_items.map((a: any) => a?.text).filter(Boolean).slice(0, 5) : [];
            return `## Call: ${r.title || "(untitled)"} ${when}\n${r.summary || "(no summary)"}${ai.length ? `\nAction items: ${ai.join("; ")}` : ""}`;
          })
          .join("\n\n");
      }
    }
  } catch {
    /* grain tables optional — degrade to generic */
  }

  const usedGrain = grainContext.trim().length > 0;

  // ── Prompt ────────────────────────────────────────────────────────────────
  const numbers = [
    `Current plan: ${ctx.currentTier || "their current tier"}${ctx.currentPay ? ` — they pay ${ctx.currentPay}/mo today (a subsidised/introductory rate)` : " (a subsidised/introductory rate)"}`,
    `Recommended plan: ${ctx.targetTier || "the next tier up"}${ctx.targetPrice ? ` at ${ctx.targetPrice}/mo` : ""}`,
    ctx.runRate ? `Their business is now running at about ${ctx.runRate}/yr in revenue` : "",
    ctx.marginPct != null ? `at roughly a ${ctx.marginPct}% net margin` : "",
    `They've been over their current plan's revenue cap for 3 straight months.`,
  ].filter(Boolean).join("\n");

  const prompt = `You are helping IronBooks — a bookkeeping + financial-coaching service for painting contractors — write a short, warm, personal note to a client, ${firstName ? `${firstName} at ${company}` : company}, about moving from their subsidised starter plan up to the plan that now fits their size.

THE FACTS:
${numbers}

${usedGrain
  ? `WHAT'S ACTUALLY GOING ON IN THEIR BUSINESS (from our recorded calls with them — use the SPECIFIC, real details here to make this personal; reference their actual growth, goals, hires, jobs, pain points):\n${grainContext.slice(0, 6000)}`
  : `We have no call notes for this client, so keep it warm and specific to their growth numbers above — do NOT invent business details.`}

WRITE THE MESSAGE:
- Tone: warm, human, from their bookkeeper — not a hard sell. Short (~130-160 words).
- Open by genuinely acknowledging their growth (${usedGrain ? "tie it to something real from the calls" : "use the revenue/margin numbers"}).
- Acknowledge plainly that they've been on a subsidised/introductory rate — they already know this — and that their growth means the ${ctx.targetTier || "next"} plan is the right fit now (more transactions, more support, more strategic help). Frame it as them outgrowing the starter plan, a good problem.
- ${usedGrain ? "Weave in 1-2 concrete specifics from their calls so it's unmistakably about THEM." : "Keep specifics to their numbers only."}
- End with a low-pressure invite to a quick call to walk through it.
- Output an email with a "Subject:" line then the body. Address them as ${firstName || "the owner"}. Sign off from "The IronBooks team". No placeholders like [X] — use what you were given or leave it out.`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    });
    const message = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    return NextResponse.json({ ok: true, message, usedGrain, recordingCount, model: MODEL });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Message generation failed" }, { status: 502 });
  }
}
