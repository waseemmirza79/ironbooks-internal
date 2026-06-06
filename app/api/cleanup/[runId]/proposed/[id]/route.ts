import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff, requireOwnerOrSenior } from "@/lib/cleanup-system/auth";
import { updateProposedDecision } from "@/lib/cleanup-system/proposed-entries";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string; id: string }> }
) {
  const { runId, id } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { decision, override_target_id, override_target_name } = body;

  if (!decision) {
    return NextResponse.json({ error: "decision required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  const { data: entry } = await service
    .from("proposed_entries")
    .select("client_link_id")
    .eq("id", id)
    .eq("run_id", runId)
    .single();
  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  const perm = await requireOwnerOrSenior(
    service,
    (entry as any).client_link_id,
    auth.userId,
    auth.role
  );
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: 403 });

  try {
    await updateProposedDecision(
      service,
      id,
      decision,
      override_target_id
        ? { targetId: override_target_id, targetName: override_target_name || "" }
        : undefined
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
