import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase";
import { requireStaff, type StaffAuthResult } from "@/lib/cleanup-system/auth";

export async function requireSeniorMonthEnd(): Promise<
  | { ok: true; auth: StaffAuthResult }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createServerSupabase();
  const auth = await requireStaff(supabase);
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!auth.isSenior) {
    return { ok: false, response: NextResponse.json({ error: "Senior access required" }, { status: 403 }) };
  }
  return { ok: true, auth };
}

export function parseJsonBody<T extends Record<string, unknown>>(body: unknown): T {
  if (!body || typeof body !== "object") return {} as T;
  return body as T;
}

export function appBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "https://app.ironbooks.com";
}
