-- ============================================================================
-- Migration 32: Prior-year taxes filed (one-time client setting)
-- ============================================================================
-- Records whether the client has filed their prior-year taxes and through
-- which year. Used downstream to:
--   - Default reclass date ranges to "current year only" so we don't touch
--     books that are already filed
--   - Warn (or block) when a bookkeeper picks a date range that overlaps
--     a filed year
--   - Surface as an indicator on the client card / kanban
--
-- Set once on client onboarding, editable from the client card.
-- ============================================================================

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS py_taxes_filed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS py_taxes_filed_through_year INTEGER,
  ADD COLUMN IF NOT EXISTS py_taxes_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS py_taxes_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Data-integrity: if filed=false, year must be NULL. Application code
-- enforces this, but a CHECK is cheap insurance against direct DB writes.
-- Wrapped in a DO block so the migration is re-runnable (PostgreSQL
-- doesn't support ADD CONSTRAINT IF NOT EXISTS for CHECK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'py_taxes_consistent'
  ) THEN
    ALTER TABLE client_links
      ADD CONSTRAINT py_taxes_consistent
      CHECK (py_taxes_filed = true OR py_taxes_filed_through_year IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN client_links.py_taxes_filed IS
  'When true, the client has filed taxes through py_taxes_filed_through_year. Used to scope reclass jobs to unfiled periods.';
COMMENT ON COLUMN client_links.py_taxes_filed_through_year IS
  'The latest calendar (or fiscal) year that has been filed. e.g. 2024 means everything up to and including 2024 is locked.';
