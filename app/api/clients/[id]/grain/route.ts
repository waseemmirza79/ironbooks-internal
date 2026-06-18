import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { normName, isIronbooks, distinctiveTokens } from "@/lib/grain-matching";

export const dynamic = "force-dynamic";

/**
 * Grain's ai_summary comes back as a JSON string like {"text":"## …\n- …"}.
 * Unwrap it to the inner markdown text so the UI can render it cleanly
 * instead of showing raw JSON. Tolerant of already-plain strings.
 */
function cleanGrainSummary(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed?.text === "string") s = parsed.text;
      else if (typeof parsed?.summary === "string") s = parsed.summary;
    } catch {
      // not valid JSON — fall through with the raw string
    }
  }
  // Collapse escaped newlines that survive when the value was double-encoded.
  return s.replace(/\\n/g, "\n").trim();
}

/**
 * GET /api/clients/[id]/grain
 *
 * Returns this client's matched Grain recordings (summary + action items
 * split into client/bookkeeper to-dos) from the persisted cache — populated
 * by the backfill + the Call Matching tab. Internal roles only.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!(actor as any)?.role || (actor as any).role === "client") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Matched recording ids for this client.
  const { data: matches } = await service
    .from("grain_recording_matches")
    .select("recording_id")
    .eq("client_link_id", id);
  const recIds = ((matches as any[]) || []).map((m) => m.recording_id);
  if (recIds.length === 0) return NextResponse.json({ configured: true, recordings: [] });

  const { data: recs } = await service
    .from("grain_recordings")
    .select("id, title, url, start_datetime, duration, summary, host_name, host_email, participants, action_items")
    .in("id", recIds)
    .order("start_datetime", { ascending: false });

  // How many clients each recording is matched to. >1 ⇒ a group/cohort call
  // (e.g. the "FAR Program" coaching calls). For those we must attribute each
  // action item to the ONE client it belongs to (by assignee), instead of
  // dumping every participant's to-dos onto all matched clients.
  const { data: allMatches } = await service
    .from("grain_recording_matches")
    .select("recording_id, client_link_id")
    .in("recording_id", recIds);
  const clientCountByRec = new Map<string, number>();
  for (const m of ((allMatches as any[]) || [])) {
    clientCountByRec.set(m.recording_id, (clientCountByRec.get(m.recording_id) || 0) + 1);
  }

  // Resolve the client's contact name(s) + business tokens for attribution.
  const { data: cl } = await service
    .from("client_links")
    .select("client_name, contact_first_name, contact_last_name")
    .eq("id", id)
    .single();
  const c = (cl as any) || {};
  const contactNorm = normName([c.contact_first_name, c.contact_last_name].filter(Boolean).join(" "));
  const bizTokens = distinctiveTokens(c.client_name || "");

  // Does a name (assignee) refer to THIS client — by contact name or a
  // distinctive business-name token? Used to pull a group-call item to the
  // right client only.
  const isThisClient = (an: string): boolean => {
    if (!an) return false;
    if (contactNorm && contactNorm.length > 4 &&
        (an === contactNorm || an.includes(contactNorm) || contactNorm.includes(an))) return true;
    if (bizTokens.length) {
      const anTokens = an.split(" ");
      if (bizTokens.every((t) => anTokens.includes(t))) return true;
    }
    return false;
  };
  // Does an item's text mention this client — used to keep an Ironbooks-owned
  // to-do on the right client in a group call ("Send Acme's P&L to …").
  const mentionsThisClient = (text: string): boolean => {
    const t = normName(text || "");
    if (contactNorm && contactNorm.length > 4 && t.includes(contactNorm)) return true;
    if (bizTokens.length && bizTokens.some((tok) => t.includes(tok))) return true;
    return false;
  };

  const payload = ((recs as any[]) || []).map((r) => {
    const participants: any[] = r.participants || [];
    const ironbooksNames = participants
      .filter((p) => isIronbooks(p.email))
      .map((p) => normName(p.name)).filter(Boolean);

    const isGroupCall = (clientCountByRec.get(r.id) || 1) > 1;
    // Onboarding calls carry a huge, mostly-internal setup checklist — too
    // noisy to surface as to-dos. Show the call + summary, but no action items.
    const isOnboarding = /onboard/i.test(r.title || "");

    const todos = { client: [] as any[], bookkeeper: [] as any[], unassigned: [] as any[] };
    if (!isOnboarding) (r.action_items || []).forEach((a: any, index: number) => {
      const item = {
        id: `${r.id}#${index}`,        // stable id for completion toggling
        recording_id: r.id,
        index,
        text: a.text,
        status: a.status ?? null,
        completed: a.completed === true || a.status === "completed",
        dueDate: a.due_date ?? a.dueDate ?? null,
        assigneeName: a.assignee_name ?? a.assigneeName ?? null,
        transcriptUrl: a.transcript_url ?? a.transcriptUrl ?? null,
      };
      if (!item.text) return;
      const an = normName(item.assigneeName);
      const isIb = !!an && ironbooksNames.some((n) => an.includes(n) || n.includes(an));

      if (isThisClient(an)) {
        todos.client.push(item);
      } else if (isIb) {
        // Ironbooks-owned task. On a 1:1 call it's about this client; on a
        // group call only keep it if the text names this client.
        if (!isGroupCall || mentionsThisClient(item.text)) todos.bookkeeper.push(item);
      } else if (!isGroupCall) {
        // 1:1 call — unassigned / other names still belong to this client.
        todos.client.push(item);
      }
      // else: group call, item belongs to a different participant — drop it.
    });

    return {
      id: r.id,
      title: r.title,
      url: r.url,
      start_datetime: r.start_datetime,
      duration: r.duration,
      host: r.host_name || r.host_email ? { name: r.host_name, email: r.host_email } : null,
      summary: cleanGrainSummary(r.summary),
      onboarding: isOnboarding,
      group_call: isGroupCall,
      participants: participants
        .filter((p) => !isIronbooks(p.email))
        .map((p) => ({ name: p.name, email: p.email })),
      todos,
    };
  });

  return NextResponse.json({ configured: true, recordings: payload });
}
