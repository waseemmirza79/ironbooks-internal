-- Migration 60: UF Audit "void_pair" resolution
-- ===============================================
-- Voids a CRM-duplicated payment AND the invoice(s) it was applied to.
-- Effect: UF down (payment void), A/R down by any open invoice balance,
-- income backed out (invoice void). No bank account involved.
-- Payment is voided first (unlinks it), then each applied invoice.
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
    'void_pair',
    'create_deposit',
    'clear_duplicate',
    'ask_client',
    'manual_investigation',
    'executed',
    'failed',
    'skipped'
  ));
