import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { loadBulkRecipients } from "@/lib/bulk-email-recipients";

export const dynamic = "force-dynamic";

/** GET /api/admin/bulk-email/recipients — admin/lead. All active clients as
 *  candidate recipients with segments + consent (the picker filters in-UI). */
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }
  const recipients = await loadBulkRecipients(service);
  return NextResponse.json({ recipients });
}
