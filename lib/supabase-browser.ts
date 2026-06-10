/**
 * Browser-only Supabase client.
 *
 * Lives in its own file because lib/supabase.ts imports `cookies` from
 * next/headers (server-only) — any "use client" component importing from
 * there breaks the production build. Client components import from HERE;
 * server code keeps using lib/supabase.ts.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

export function createBrowserSupabase() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
