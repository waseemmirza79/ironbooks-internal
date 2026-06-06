import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/cleanup-system/auth";
import { signOffCpaFlag } from "@/lib/cleanup-system/cpa-flags";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data } = await service
    .from("cpa_flags")
    .select("*")
    .eq("run_id", runId)
    .order("created_at");

  return NextResponse.json({ flags: data || [] });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!auth.isSenior) {
    return NextResponse.json({ error: "Only lead/admin can sign off CPA flags" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { flag_id, action, notes } = body;
  if (!flag_id || action !== "sign_off") {
    return NextResponse.json({ error: "flag_id and action=sign_off required" }, { status: 400 });
  }

  const service = createServiceSupabase();
  try {
    await signOffCpaFlag(service, flag_id, auth.userId, notes);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
