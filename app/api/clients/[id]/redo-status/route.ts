import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { getRedoStatus, type RedoKind } from "@/lib/redo-guard";

/**
 * GET /api/clients/[id]/redo-status?kind=coa|reclass|rules
 * Used by the New-job forms to warn (load-time, deep-link-safe) before redoing
 * a client that's already cleaned up or already has a completed job of that type.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = new URL(request.url).searchParams.get("kind");
  if (!["coa", "reclass", "rules"].includes(kind || "")) {
    return NextResponse.json({ error: "kind must be coa|reclass|rules" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const status = await getRedoStatus(service, id, kind as RedoKind);
  return NextResponse.json(status);
}
