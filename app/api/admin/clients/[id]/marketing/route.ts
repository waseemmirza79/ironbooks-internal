import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** POST /api/admin/clients/[id]/marketing — admin/lead. Body { subscribe }.
 *  Manual (re)subscribe of a client to marketing email — e.g. after talking
 *  to them and confirming they want updates again. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({} as any));
  const subscribe = body.subscribe !== false;
  const { error } = await service.from("client_links").update({
    marketing_subscribed: subscribe,
    marketing_unsubscribed_at: subscribe ? null : new Date().toISOString(),
    marketing_unsub_source: subscribe ? null : "admin",
  } as any).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, subscribed: subscribe });
}
