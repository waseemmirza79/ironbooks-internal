-- Migration 10: Add due_date to client_links
-- Managers set this when assigning a bookkeeper.
-- Auto-set to today+2 when a junior bookkeeper connects their own QBO account.

ALTER TABLE client_links ADD COLUMN IF NOT EXISTS due_date date;
