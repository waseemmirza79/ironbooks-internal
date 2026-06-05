-- Migration 47: payroll_double_entry item type for hardcore cleanup
--
-- Context:
--   QBO Payroll's Direct Deposit transactions are GL-locked — the
--   bookkeeper can't void or delete them. When the bookkeeper (or QBO's
--   bank feed) also records a Transfer of the same payroll dollars from
--   the operating account to the payroll funding account AND categorizes
--   it as Wages/Salaries/Payroll Expense (instead of as a bank-to-bank
--   transfer or to a clearing account), the wage expense gets booked
--   twice.
--
--   Clean Cut Painters caught this: P&L showed -$18k for the month and
--   -$50k YTD because every QBO Payroll DD had a sibling Transfer
--   hitting the same Wages account. Lisa confirmed BMD has the same
--   pattern. Likely affects most QBO Payroll clients.
--
--   Detection logic (lib/payroll-double-entry.ts): for each payroll
--   expense account, find pairs of (Paycheck DD, Transfer/JE) on near
--   dates with matching amounts — flag the Transfer as the duplicate.
--
--   Resolution: re-categorize the Transfer's posting line from the wage
--   account to a Payroll Clearing wash account (or bank-to-bank). The
--   `recategorize` resolution type does this via sparse update — V2
--   follow-up.
--
-- Safe to re-run: DROP/ADD CHECK CONSTRAINT idempotently.

-- Postgres doesn't have ADD VALUE TO CHECK semantics; we drop + recreate.
-- The constraint name follows hardcore_cleanup_items_item_type_check
-- (default name PG generates from CHECK (item_type IN (...))).
ALTER TABLE hardcore_cleanup_items
  DROP CONSTRAINT IF EXISTS hardcore_cleanup_items_item_type_check;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_item_type_check
  CHECK (item_type IN (
    'duplicate_invoice',
    'orphan_uf_payment',
    'stale_ar',
    'unmatched_payment',
    'missing_invoice',
    'unmatched_job',
    'payroll_double_entry'
  ));

-- Optional new columns for storing the paired-DD info on payroll items.
-- The detector needs to surface "this Transfer (id X, amount Y) duplicates
-- this Paycheck DD (id Z, amount Y)" — re-using surviving_qbo_invoice_id
-- to mean "the locked Payroll DD" keeps schema flat. Adding a clearer
-- alias here so future code reads obviously.
ALTER TABLE hardcore_cleanup_items
  ADD COLUMN IF NOT EXISTS paired_locked_txn_id TEXT,
  ADD COLUMN IF NOT EXISTS paired_locked_txn_type TEXT,
  ADD COLUMN IF NOT EXISTS paired_locked_txn_date DATE;

COMMENT ON COLUMN hardcore_cleanup_items.paired_locked_txn_id IS
  'For payroll_double_entry items: the QBO id of the LOCKED Paycheck/DD that the user-recordable Transfer duplicates. Used by the resolution UI to show the pair side-by-side.';

CREATE INDEX IF NOT EXISTS hardcore_cleanup_items_payroll_double_entry_idx
  ON hardcore_cleanup_items (run_id, item_type)
  WHERE item_type = 'payroll_double_entry';

SELECT 'migration_47 applied' AS status;
