-- Migration 23: Kanban workflow support
-- Run in Supabase SQL editor

-- ── client_links additions ──────────────────────────────────────────────────

-- Whether a QBO deposit scan found Stripe-pattern transactions (≥$1,000)
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS stripe_detected boolean NOT NULL DEFAULT false;

-- When a Stripe connect request email was sent during onboarding
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS stripe_request_sent_at timestamptz;

-- Pause a client from appearing in active workflow columns
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS kanban_on_hold boolean NOT NULL DEFAULT false;

-- ── reclass_jobs additions ───────────────────────────────────────────────────

-- Manual "month closed" stamp set by bookkeeper at end of MoM cycle
ALTER TABLE reclass_jobs
  ADD COLUMN IF NOT EXISTS month_closed_at timestamptz;

ALTER TABLE reclass_jobs
  ADD COLUMN IF NOT EXISTS month_closed_by uuid REFERENCES users(id);

-- ── client_notes ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id  uuid NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES users(id),
  body            text NOT NULL,
  reminder_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_notes_client_idx ON client_notes(client_link_id);
CREATE INDEX IF NOT EXISTS client_notes_reminder_idx ON client_notes(reminder_at) WHERE reminder_at IS NOT NULL;

-- RLS
ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read notes
CREATE POLICY "Authenticated users can read client notes"
  ON client_notes FOR SELECT
  TO authenticated
  USING (true);

-- Only the author can insert/update/delete their own notes
CREATE POLICY "Authors can insert notes"
  ON client_notes FOR INSERT
  TO authenticated
  WITH CHECK (author_id = auth.uid());

CREATE POLICY "Authors can update their notes"
  ON client_notes FOR UPDATE
  TO authenticated
  USING (author_id = auth.uid());

CREATE POLICY "Authors can delete their notes"
  ON client_notes FOR DELETE
  TO authenticated
  USING (author_id = auth.uid());

-- ── indexes for kanban queries ───────────────────────────────────────────────

-- Speed up "clients in onboarding" queries
CREATE INDEX IF NOT EXISTS client_links_cleanup_completed_idx
  ON client_links(cleanup_completed_at) WHERE cleanup_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS client_links_assigned_bookkeeper_idx
  ON client_links(assigned_bookkeeper_id);

CREATE INDEX IF NOT EXISTS client_links_on_hold_idx
  ON client_links(kanban_on_hold) WHERE kanban_on_hold = true;

-- Speed up "most recent job per client" lookups
CREATE INDEX IF NOT EXISTS reclass_jobs_client_created_idx
  ON reclass_jobs(client_link_id, created_at DESC);

CREATE INDEX IF NOT EXISTS reclass_jobs_month_closed_idx
  ON reclass_jobs(month_closed_at) WHERE month_closed_at IS NULL;
