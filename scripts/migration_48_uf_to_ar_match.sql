-- Migration 48: uf_to_ar_match item type for hardcore cleanup
--
-- Context:
--   Until now hardcore-cleanup only matched Undeposited Funds payments
--   against CRM jobs (uf_match). To match a UF payment directly to a QBO
--   open invoice the bookkeeper had to bounce out to the standalone
--   /balance-sheet/uf-ar tool — which is the workflow we're consolidating.
--
--   This adds a new item_type so hardcore-cleanup can persist UF↔A/R
--   matches when no CRM CSV is present (or in addition to CRM matching).
--   The push-to-QBO path is `apply_payment`, which finalize already
--   handles end-to-end via applyPaymentToInvoices.
--
--   For Clean Cut's $338K Undeposited Funds problem: previously the
--   bookkeeper had to upload a DripJobs CSV to see matches; now hitting
--   "Scan UF only" runs the matcher against QBO open A/R directly.
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
    'uf_to_ar_match'
  ));

SELECT 'migration_48 applied' AS status;
