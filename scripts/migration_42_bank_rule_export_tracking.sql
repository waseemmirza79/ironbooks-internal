-- Migration 42: Track when each bank_rule was last exported to QBO via .xls
--
-- Context:
--   Mike runs SNAP bank-rule discovery on the same client across multiple
--   periods (3-12 month lookback). Without tracking what's been exported,
--   each re-export produces a .xls that overlaps prior exports — when Lisa
--   imports it, QBO creates duplicate rules (QBO doesn't dedupe imports).
--
--   The boolean `pushed_to_qbo` exists already but has no timestamp, so we
--   can't tell when a rule was exported or compute "what's new since last
--   export". This migration adds the timestamp.
--
--   Semantic shift: `pushed_to_qbo` used to mean "we POSTed it via QBO's
--   /bankrule API". That endpoint is unsupported by Intuit (returns
--   Unsupported Operation), so the API push path is dead. The flag is now
--   repurposed to mean "this rule is in QBO" — set when the .xls export
--   includes it OR when Lisa marks it as manually-created-in-QBO. The
--   existing read at app/reclass/[id]/bank-rules/page.tsx:153 already
--   matches this semantics.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.

ALTER TABLE bank_rules
  ADD COLUMN IF NOT EXISTS pushed_to_qbo_at TIMESTAMPTZ;

-- Backfill: any row where pushed_to_qbo=true but pushed_to_qbo_at is null
-- gets backfilled to created_at as a sensible best-guess. No rows match
-- this today (we never set pushed_to_qbo=true previously) but harmless.
UPDATE bank_rules
SET pushed_to_qbo_at = created_at
WHERE pushed_to_qbo = TRUE
  AND pushed_to_qbo_at IS NULL;

-- Index supports the export-qbo endpoint's "rules added since last export"
-- query: WHERE client_link_id = $1 AND (pushed_to_qbo IS NOT TRUE OR ...)
CREATE INDEX IF NOT EXISTS bank_rules_export_status_idx
  ON bank_rules (client_link_id, pushed_to_qbo)
  WHERE status = 'active';

-- Verify:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'bank_rules'
  AND column_name IN ('pushed_to_qbo', 'pushed_to_qbo_at');
