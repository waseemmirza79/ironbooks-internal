-- Migration 59: UF Audit "clear_duplicate" resolution
-- ====================================================
-- Adds the 'clear_duplicate' resolution for orphan UF payments whose cash
-- was ALREADY recorded via a separate bank-feed deposit (CRM double-count).
-- Finalize posts a ZERO-DOLLAR Bank Deposit: LinkedTxn lines sweep the stuck
-- payments out of UF (+$X) and one negative offset line to an income account
-- (−$X) reverses the double-counted revenue. No bank-balance or A/R impact.
--
-- The offset income account reuses the existing resolution_target_account_id
-- / resolution_target_account_name columns (same as the JE resolutions), and
-- the $0 deposit's container bank reuses deposit_bank_account_id/_name from
-- migration 57. No new columns needed.
--
-- Idempotent — safe to run more than once.

ALTER TABLE uf_audit_items
  DROP CONSTRAINT IF EXISTS uf_audit_items_resolution_check;

ALTER TABLE uf_audit_items
  ADD CONSTRAINT uf_audit_items_resolution_check
  CHECK (resolution IN (
    'pending',
    'owner_draw',
    'write_off',
    'duplicate_recategorize',
    'void_duplicate',
    'create_deposit',
    'clear_duplicate',
    'ask_client',
    'manual_investigation',
    'executed',
    'failed',
    'skipped'
  ));
