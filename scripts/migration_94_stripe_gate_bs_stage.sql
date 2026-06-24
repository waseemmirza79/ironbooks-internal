-- Migration 94: client_links columns for the deposit-gated Stripe flow + the
-- Balance Sheet stage. Idempotent. Apply via the Supabase SQL editor.
--
-- Reuses existing stripe_request_sent_at (mig 23) / stripe_request_sent_confirmed_at
-- (mig 26) for the manual kanban/comms flow; the NEW stripe_connect_* columns track
-- the AUTOMATED direct-send + reminder lifecycle so they don't collide.

ALTER TABLE client_links
  -- Stripe deposit gate (cached result of the QBO deposit-exists check) --------
  ADD COLUMN IF NOT EXISTS stripe_deposits_detected         boolean,
  ADD COLUMN IF NOT EXISTS stripe_deposits_detected_at      timestamptz,

  -- Automated connect-request + reminder clock -------------------------------
  -- when the FIRST automated connect email went out (reminder cron counts from here)
  ADD COLUMN IF NOT EXISTS stripe_connect_requested_at      timestamptz,
  -- number of reminder emails sent so far (initial send = 0; each cron reminder +1)
  ADD COLUMN IF NOT EXISTS stripe_connect_reminder_count    integer NOT NULL DEFAULT 0,
  -- last time ANY connect email (initial or reminder) was sent; enforces the 3-day cadence
  ADD COLUMN IF NOT EXISTS stripe_connect_last_reminder_at  timestamptz,
  -- set when the 9-day "call the client" Today task is created (de-dup + stop reminders)
  ADD COLUMN IF NOT EXISTS stripe_connect_task_created_at   timestamptz,

  -- Balance Sheet stage: P&L attestation (cleanup-scoped) --------------------
  ADD COLUMN IF NOT EXISTS pl_attested_at                   timestamptz,
  ADD COLUMN IF NOT EXISTS pl_attested_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pl_attestation_notes             text,
  -- when the statement-request email was sent (for "requested on {date}")
  ADD COLUMN IF NOT EXISTS bs_statements_requested_at       timestamptz,
  -- resume the 4-sub-step BS flow where the bookkeeper left off
  ADD COLUMN IF NOT EXISTS bs_substep                       text;

-- Cron scan predicate: pending connect requests not yet escalated, by age.
CREATE INDEX IF NOT EXISTS idx_client_links_stripe_connect_followup
  ON client_links (stripe_connect_requested_at)
  WHERE stripe_connect_requested_at IS NOT NULL
    AND stripe_connect_task_created_at IS NULL;

-- "Attested but not yet submitted" lookup.
CREATE INDEX IF NOT EXISTS idx_client_links_pl_attested_at
  ON client_links (pl_attested_at)
  WHERE pl_attested_at IS NOT NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND (column_name LIKE 'stripe_connect_%'
       OR column_name LIKE 'stripe_deposits_%'
       OR column_name LIKE 'pl_att%'
       OR column_name LIKE 'bs_s%')
ORDER BY column_name;
