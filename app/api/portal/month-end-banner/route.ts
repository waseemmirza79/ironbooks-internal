import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { getUnseenPackageBanner } from "@/lib/month-end/portal-package";

export const dynamic = "force-dynamic";

/** GET — unseen month-end package banner for portal home */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ banner: null });

  const service = createServiceSupabase();
  const banner = await getUnseenPackageBanner(
    service,
    ctxResult.ctx.clientLinkId,
    user.id
  );

  return NextResponse.json({ banner });
}

/** POST — dismiss banner after client views statements */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const packageId = typeof body.package_id === "string" ? body.package_id : "";
  if (!packageId) return NextResponse.json({ error: "package_id required" }, { status: 400 });

  const service = createServiceSupabase();
  const { data: pkg } = await service
    .from("month_end_packages")
    .select("id, status")
    .eq("id", packageId)
    .eq("client_link_id", ctxResult.ctx.clientLinkId)
    .eq("status", "sent")
    .maybeSingle();

  if (!pkg) {
    return NextResponse.json({ error: "Package not found or not published" }, { status: 404 });
  }

  await (service.from("client_users" as any) as any)
    .update({ last_seen_package_id: packageId })
    .eq("user_id", user.id)
    .eq("client_link_id", ctxResult.ctx.clientLinkId);

  return NextResponse.json({ ok: true });
}
