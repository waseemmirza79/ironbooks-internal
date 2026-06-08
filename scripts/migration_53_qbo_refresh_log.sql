-- Migration 53: QBO refresh observability + lock infrastructure
--
-- Context:
--   ~52% of the fleet (32 of 62 clients) has a dead QBO refresh token
--   right now. Diagnosis: refresh-token rotation race. Multiple services
--   (Ironbooks itself running concurrent requests + the coach-intel
--   project sharing Supabase) all try to refresh the same one-time-use
--   token; rotation chain breaks; future refreshes return invalid_grant.
--
--   This migration adds two things:
--
--   1. qbo_refresh_log — every refresh attempt (success or fail) gets a
--      row. Source (caller identity), result, intuit_tid for trace.
--      Without this we can't tell who's racing on the next outage.
--
--   2. (No DB lock object needed — pg_advisory_xact_lock is per-session,
--      no table required. The code-level lock lives in lib/qbo.ts.)
--
-- Safe to re-run: IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS qbo_refresh_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  UUID REFERENCES client_links(id) ON DELETE CASCADE,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Free-text identifier for the caller. getValidToken passes its
  -- best guess from request headers + env. Examples: "ironbooks/api/reclass/discover",
  -- "ironbooks/cron/stripe-invite-detector", "coach-intel/<unknown>",
  -- "ironbooks/api/fleet/qbo-health-check". Helps spot rogue refreshers.
  source          TEXT,
  -- success | invalid_grant | other_error
  result          TEXT NOT NULL,
  -- Intuit's tracing id from the refresh response. Useful when filing
  -- support tickets with Intuit.
  intuit_tid      TEXT,
  -- Error detail when result != success
  error_message   TEXT,
  -- Time spent inside the refresh call (Intuit POST + our DB update).
  -- High p99 here is a red flag for lock contention under load.
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS qbo_refresh_log_client_idx
  ON qbo_refresh_log (client_link_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS qbo_refresh_log_recent_idx
  ON qbo_refresh_log (attempted_at DESC);
CREATE INDEX IF NOT EXISTS qbo_refresh_log_failures_idx
  ON qbo_refresh_log (result, attempted_at DESC)
  WHERE result <> 'success';

-- ── Advisory-lock RPC wrappers ──────────────────────────────────────
--
-- Supabase's PostgREST doesn't expose pg_advisory_lock/unlock by default.
-- Wrap them in SECURITY DEFINER functions the service role can call.
-- getValidToken in lib/qbo.ts calls these via supabase.rpc().
--
-- Lock scope: per-(client_link_id) hashed bigint. Concurrent refreshes
-- for the same client serialize; different clients run in parallel.
CREATE OR REPLACE FUNCTION pg_advisory_lock(key bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pg_advisory_lock($1);
$$;

CREATE OR REPLACE FUNCTION pg_advisory_unlock(key bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT pg_advisory_unlock($1);
$$;

-- Allow the service role to call them. (RLS doesn't apply to functions
-- the way it does to tables; this is just an explicit grant for the
-- PostgREST anon/service-role to invoke them via RPC.)
GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION pg_advisory_unlock(bigint) TO service_role;

SELECT 'migration_53 applied' AS status;
