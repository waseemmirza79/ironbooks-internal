-- Migration 45: Per-item JE posting date for hardcore cleanup
--
-- Context:
--   Today every JE write-off / push-invoice / apply-payment that finalize
--   creates in QBO uses `today` as the TxnDate (hardcore-cleanup finalize
--   line 114). For bulk runs where the bookkeeper is cleaning up months
--   or years of stale activity, posting everything to today's date can
--   misstate the period totals. Bookkeeper needs to set a specific JE
--   date — typically the original CRM job date or a chosen "as-of" date
--   for the cleanup batch.
--
--   Schema: add an optional resolution_je_date column. NULL means
--   finalize keeps the current `today` behaviour (backwards-compatible).
--   When set, finalize uses it as the TxnDate for the QBO posting.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.

ALTER TABLE hardcore_cleanup_items
  ADD COLUMN IF NOT EXISTS resolution_je_date DATE;

COMMENT ON COLUMN hardcore_cleanup_items.resolution_je_date IS
  'Optional override for the QBO posting date used when finalize creates a JE / push-invoice / apply-payment for this item. NULL = post on today''s date.';

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'hardcore_cleanup_items'
  AND column_name = 'resolution_je_date';
