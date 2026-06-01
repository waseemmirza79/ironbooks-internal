import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";

/**
 * POST /api/clients/[id]/unlink-double
 *
 * Clears the Double Finance linkage on this client (double_client_id +
 * double_client_name). Used when:
 *   - The wrong Double client was matched
 *   - The client's Double account was renamed/migrated and needs to be
 *     re-matched
 *
 * Permission: admin or lead. Bookkeepers don't unlink — they ask a
 * lead/admin. This mirrors the existing pattern for destructive ops on
 * /clients/[id] (delete, disconnect Stripe, etc).
 *
 * Audit-logged with the prior values so the action is traceable.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (actor as any)?.role;
  if (role !== "admin" && role !== "lead") {
    return NextResponse.json(
      { error: "Forbidden — admin or lead only" },
      { status: 403 }
    );
  }

  // Read prior values so we can audit-log them BEFORE clearing — otherwise
  // we'd lose the info forever and "who was this linked to?" becomes
  // unanswerable.
  const { data: prior } = await service
    .from("client_links")
    .select("double_client_id, double_client_name, client_name")
    .eq("id", id)
    .single();

  if (!prior) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // The link uses NOT NULL with a default empty string on double_client_id
  // in some deployments. Setting to "" instead of null sidesteps the
  // constraint regardless. The "really linked" check elsewhere is
  // !startsWith("pending_") + truthy, so empty string is correctly read
  // as "no link" everywhere it matters.
  const { error } = await service
    .from("client_links")
    .update({
      double_client_id: "",
      double_client_name: null,
    } as any)
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await service.from("audit_log").insert({
    event_type: "client_double_unlinked",
    user_id: user.id,
    request_payload: {
      client_link_id: id,
      client_name: (prior as any).client_name,
      prior_double_client_id: (prior as any).double_client_id,
      prior_double_client_name: (prior as any).double_client_name,
    } as any,
  });

  return NextResponse.json({ ok: true });
}
