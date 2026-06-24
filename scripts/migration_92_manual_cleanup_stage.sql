-- Migration 92 — "Manual cleanup needed in QuickBooks" stage
-- =========================================================================
-- Adds a client-level flag + bookkeeper notes for the new cleanup stage. The
-- auto-generated detail still lives in coa_jobs.manual_cleanup_items (written
-- by lib/executor.ts when a COA job hits QBO platform limits); this flag is
-- what places the client in the "Manual cleanup (QBO)" column and holds the
-- bookkeeper's free-text description of what to fix by hand. Additive +
-- idempotent — safe to re-run.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS manual_cleanup_needed      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_cleanup_notes       text,
  ADD COLUMN IF NOT EXISTS manual_cleanup_set_at      timestamptz,
  ADD COLUMN IF NOT EXISTS manual_cleanup_set_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_cleanup_resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_client_links_manual_cleanup_needed
  ON client_links (manual_cleanup_needed) WHERE manual_cleanup_needed;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links' AND column_name LIKE 'manual_cleanup%'
ORDER BY column_name;
