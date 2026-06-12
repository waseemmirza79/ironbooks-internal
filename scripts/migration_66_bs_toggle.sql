-- Migration 66: per-client Balance Sheet toggle
-- ===============================================
-- A client can graduate to Production with the Balance Sheet switched OFF
-- — they get P&L-focused monthly service (uncategorized + A/R checks,
-- P&L statement review/close) while the BS cleanup finishes on its own
-- timeline. Toggle lives on the Production board (admin/lead).
--
-- Idempotent — safe to run more than once.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS bs_enabled boolean NOT NULL DEFAULT true;
