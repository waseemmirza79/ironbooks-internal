import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET  /api/clients/[id]/notes  — list notes for a client
 * POST /api/clients/[id]/notes  — create a note
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: notes, error } = await service
    .from("client_notes")
    .select("id, body, reminder_at, created_at, updated_at, author_id, users!author_id(full_name, avatar_url)")
    .eq("client_link_id", clientId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ notes: notes || [] });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { body: noteBody, reminder_at } = body;

  if (!noteBody?.trim()) {
    return NextResponse.json({ error: "Note body required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  const { data: note, error } = await service
    .from("client_notes")
    .insert({
      client_link_id: clientId,
      author_id: user.id,
      body: noteBody.trim(),
      reminder_at: reminder_at || null,
    } as any)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ note });
}

/**
 * DELETE /api/clients/[id]/notes?note_id=xxx
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const noteId = searchParams.get("note_id");
  if (!noteId) return NextResponse.json({ error: "note_id required" }, { status: 400 });

  const service = createServiceSupabase();

  const { data: note } = await service
    .from("client_notes")
    .select("author_id, client_link_id")
    .eq("id", noteId)
    .single();

  if (!note || note.client_link_id !== clientId) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const isSenior = ["admin", "lead"].includes(actor?.role ?? "");
  if (note.author_id !== user.id && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await service.from("client_notes").delete().eq("id", noteId);

  return NextResponse.json({ ok: true });
}
