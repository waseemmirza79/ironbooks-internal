-- Migration: add 'full_categorization' workflow + auto_approve_threshold column
-- Run in Supabase SQL editor before deploying.

-- 1. New workflow type — for AI-driven categorization of ALL transactions against the new COA
ALTER TYPE reclass_workflow ADD VALUE IF NOT EXISTS 'full_categorization';

-- 2. New column — the dollar threshold below which AI auto-approves decisions
ALTER TABLE reclass_jobs
  ADD COLUMN IF NOT EXISTS auto_approve_threshold numeric DEFAULT 500;

-- 3. source_account_id / source_account_name need to be nullable for full_categorization
--    (no single source — it pulls from all accounts). Already nullable in some installs;
--    these statements are no-ops if already nullable.
ALTER TABLE reclass_jobs ALTER COLUMN source_account_id DROP NOT NULL;
ALTER TABLE reclass_jobs ALTER COLUMN source_account_name DROP NOT NULL;
