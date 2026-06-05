-- Migration 49: uncat_income item type for hardcore cleanup
--
-- Context:
--   The standalone /balance-sheet/[client_id]/uncat-income-recovery tool
--   scans Uncategorized Income deposits + JEs in QBO and tries to match
--   them to open invoices (so the bookkeeper can recategorize / apply
--   them as payments instead of leaving revenue in a dump account).
--
--   Consolidation: hardcore-cleanup absorbs that workflow. When the
--   bookkeeper runs a qbo_only scan we also scan Uncategorized Income
--   and persist hits as hardcore_cleanup_items.item_type = 'uncat_income'.
--
--   Resolution paths for v1 are conservative — bookkeeper reviews and
--   marks each one `manual` after fixing in QBO. v2 wires a recategorize
--   resolution that does the sparse update on the Deposit/JE Line.
--
-- Safe to re-run: DROP/ADD CHECK CONSTRAINT idempotently.

ALTER TABLE hardcore_cleanup_items
  DROP CONSTRAINT IF EXISTS hardcore_cleanup_items_item_type_check;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_item_type_check
  CHECK (item_type IN (
    -- v1 (Migration 41)
    'duplicate_invoice',
    'orphan_uf_payment',
    'stale_ar',
    'unmatched_payment',
    -- v2 (Migration 44 — unified workflow with CRM CSV)
    'missing_invoice',
    'uf_match',
    'unmatched_job',
    'unmatched_uf',
    -- v3 (Migration 47 — payroll double-entry detector)
    'payroll_double_entry',
    -- v4 (Migration 48 — UF↔A/R direct match, no CRM CSV required)
    'uf_to_ar_match',
    -- v5 (Migration 49 — Uncategorized Income consolidation)
    'uncat_income'
  ));

SELECT 'migration_49 applied' AS status;
