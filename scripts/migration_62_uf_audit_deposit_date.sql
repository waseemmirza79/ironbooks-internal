-- Migration 62: UF Audit — bookkeeper-selectable deposit date
--
-- Before this, the Bank Deposit posted by a create_deposit resolution
-- used the PAYMENT date as its TxnDate. That made bank reconciliation
-- painful: bank statements group multiple payments into one deposit on
-- the date the money actually cleared, not the date each individual
-- payment was received. Bookkeepers were having to manually adjust each
-- deposit's date in QBO after finalize to match the bank statement.
--
-- This adds a nullable deposit_date column. When set, the finalize route
-- groups orphans by (bank, deposit_date) instead of (bank, payment_date)
-- and uses deposit_date as the QBO Deposit's TxnDate. When null (legacy
-- rows), the finalize route falls back to payment_date — backward
-- compatible.

ALTER TABLE uf_audit_items
  ADD COLUMN IF NOT EXISTS deposit_date DATE;

COMMENT ON COLUMN uf_audit_items.deposit_date IS
  'For create_deposit / clear_duplicate resolutions: the date the bookkeeper wants the QBO Deposit posted on. NULL falls back to payment_date (legacy behavior).';
