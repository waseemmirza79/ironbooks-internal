/**
 * Supabase Client Configuration
 * -----------------------------
 * Two client types:
 *  - Browser client (uses anon key, respects RLS)
 *  - Server client (uses service role key, bypasses RLS for system operations)
 *
 * Use the server client ONLY in API routes or server actions.
 * Never expose the service role key to the browser.
 */

import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from './database.types';

// ============== BROWSER CLIENT ==============
// Re-exported from lib/supabase-browser.ts (its own file so "use client"
// components can import it without dragging next/headers into the bundle).
// Client components should import from "@/lib/supabase-browser" directly.
export { createBrowserSupabase } from './supabase-browser';

// ============== SERVER CLIENT (with cookies, respects RLS) ==============
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server components can't set cookies - ignore
          }
        },
      },
    }
  );
}

// ============== SERVICE ROLE CLIENT (bypasses RLS) ==============
// Use ONLY for trusted system operations: cron jobs, webhooks, integrations
// that need to write across all clients.
export function createServiceSupabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
