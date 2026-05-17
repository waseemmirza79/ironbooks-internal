-- Migration 11: Add new skip reasons to reclass_skip_reason enum
--
-- balance_sheet_account — used by full_categorization to skip BS lines
--   (AR/AP, credit cards, bank transfers, fixed assets, equity, liabilities)
--
-- already_correct — used by all reclass workflows to skip lines whose
--   current account ID already matches the determined target. Lets re-runs
--   on already-migrated clients show zero work instead of pointless no-ops.
--
-- Both ADD VALUE IF NOT EXISTS for idempotency.

ALTER TYPE reclass_skip_reason ADD VALUE IF NOT EXISTS 'balance_sheet_account';
ALTER TYPE reclass_skip_reason ADD VALUE IF NOT EXISTS 'already_correct';

-- Verify:
SELECT enumlabel
FROM pg_enum
WHERE enumtypid = 'reclass_skip_reason'::regtype
ORDER BY enumsortorder;
