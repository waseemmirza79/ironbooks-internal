-- Migration 51: recategorize resolution for hardcore cleanup
--
-- Context:
--   Uncategorized Income items (item_type='uncat_income') in
--   hardcore-cleanup currently sit at resolution='pending' — the
--   bookkeeper marks them `manual` and fixes in QBO directly because
--   we have no finalize path for them. This adds a `recategorize`
--   resolution + finalize handler that sparse-updates the Deposit / JE
--   Line.AccountRef in QBO from Uncategorized Income to a target
--   revenue account picked by the bookkeeper.
--
--   For the typical Clean Cut / BMD case: $5,000 deposit landed in
--   Uncategorized Income, should have been Painting Revenue. Bookkeeper
--   picks Painting Revenue + clicks Finalize → SNAP fetches the Deposit
--   by id, updates the Line whose AccountRef points at Uncat Income to
--   point at Painting Revenue instead, POSTs back via sparse update.
--   Same SyncToken / optimistic-concurrency dance as direct_void.
--
-- Safe to re-run: DROP/ADD CHECK CONSTRAINT idempotently.

ALTER TABLE hardcore_cleanup_items
  DROP CONSTRAINT IF EXISTS hardcore_cleanup_items_resolution_check;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_resolution_check
  CHECK (resolution IN (
    'pending',
    'je_writeoff',
    'direct_void',
    'keep',
    'manual',
    'executed',
    'failed',
    'skipped',
    'push_invoice',
    'apply_payment',
    'ask_client',
    'split_deposit',
    -- v6 (Migration 51 — Uncategorized Income auto-fix path)
    'recategorize'
  ));

SELECT 'migration_51 applied' AS status;
