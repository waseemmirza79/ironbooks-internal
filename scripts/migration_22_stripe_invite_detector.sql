-- Migration 22: Stripe invite detector state on client_links
--
-- Level-1 automation for the "client has Stripe deposits but isn't
-- connected" workflow. A nightly detector scans every QBO-connected
-- client without an active Stripe connection over the last 3 months
-- and writes its findings here. The dashboard then renders a "Pending
-- Stripe Invites Detected" widget so the bookkeeper can send the
-- Connect link with one click.
--
-- Idempotent.

ALTER TABLE client_links
  -- When the detector last found Stripe-tagged deposits for this client.
  -- Null = nothing detected (or never scanned).
  ADD COLUMN IF NOT EXISTS stripe_invite_suggested_at timestamptz,
  -- How many Stripe-tagged QBO deposits showed up in the last scan
  -- window. Drives the widget copy ("7 deposits totaling $16,088.29").
  ADD COLUMN IF NOT EXISTS stripe_invite_deposit_count int,
  ADD COLUMN IF NOT EXISTS stripe_invite_deposit_total numeric,
  -- When the detector last ran for this client (regardless of result).
  -- Used to avoid re-scanning every minute.
  ADD COLUMN IF NOT EXISTS stripe_invite_last_scan_at timestamptz,
  -- "Don't ask again" — bookkeeper has reviewed and decided not to send
  -- an invite (e.g., client speaks limited English, already declined,
  -- or the deposits aren't really Stripe). Set via the Dismiss button
  -- on the dashboard widget.
  ADD COLUMN IF NOT EXISTS stripe_invite_dismissed_at timestamptz;

-- Index for the dashboard widget query (rows where suggested_at is set,
-- not dismissed, not yet connected, ordered newest-suggestion-first).
CREATE INDEX IF NOT EXISTS idx_client_links_stripe_invite
  ON client_links (stripe_invite_suggested_at DESC NULLS LAST)
  WHERE stripe_invite_suggested_at IS NOT NULL
    AND stripe_invite_dismissed_at IS NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name IN (
    'stripe_invite_suggested_at',
    'stripe_invite_deposit_count',
    'stripe_invite_deposit_total',
    'stripe_invite_last_scan_at',
    'stripe_invite_dismissed_at'
  )
ORDER BY column_name;
