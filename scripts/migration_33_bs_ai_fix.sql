-- ============================================================================
-- Migration 33: AI-assisted Balance Sheet cleanup
-- ============================================================================
-- Persists AI cleanup runs so:
--   - Analysis isn't re-paid when reopening the review page
--   - Per-fix decisions (accept / modify / reject) survive page reloads
--   - Audit trail records who approved what before it shipped to QBO
--
-- Two tables:
--   bs_ai_fix_runs  — one row per analyze() call
--   bs_ai_fix_items — one row per issue Claude surfaced in that run
-- ============================================================================

CREATE TABLE IF NOT EXISTS bs_ai_fix_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Status of the overall run
  status TEXT NOT NULL DEFAULT 'analyzing'
    CHECK (status IN ('analyzing','review','finalizing','finalized','failed','cancelled')),

  -- Aggregate stats for the run
  issues_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  total_estimated_impact NUMERIC NOT NULL DEFAULT 0,

  -- Snapshot context for the AI call
  snapshot_summary JSONB,
  ai_summary TEXT,
  ai_warnings JSONB DEFAULT '[]'::jsonb,
  duration_ms INTEGER,
  error_message TEXT,

  -- Finalization tracking
  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalize_results JSONB
);

CREATE INDEX IF NOT EXISTS idx_bs_ai_fix_runs_client
  ON bs_ai_fix_runs(client_link_id, created_at DESC);

COMMENT ON TABLE bs_ai_fix_runs IS
  'One row per AI BS cleanup analysis call. Persists so the review screen survives reloads without re-paying for Claude.';


CREATE TABLE IF NOT EXISTS bs_ai_fix_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES bs_ai_fix_runs(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  -- Issue identification
  kind TEXT NOT NULL CHECK (kind IN (
    'undeposited_funds_clearing',
    'suspense_reclass',
    'obe_to_retained_earnings',
    'stale_uncleared_bank_line',
    'ar_aging_writeoff',
    'ap_aging_writeoff',
    'negative_balance',
    'inter_account_transfer_dupe',
    'other'
  )),
  account_qbo_id TEXT,
  account_name TEXT,
  description TEXT NOT NULL,
  ai_reasoning TEXT,

  -- Proposed fix — one of:
  --   { type: 'reclass_lines', lines: [{ qbo_transaction_id, qbo_line_id, sync_token, transaction_type, new_account_id, new_account_name, amount }] }
  --   { type: 'journal_entry', je: { txn_date, doc_number, private_note, lines: [{ posting_type: 'Debit'|'Credit', amount, account_id, account_name, description }] } }
  --   { type: 'flag_for_manual', notes }
  proposed_fix JSONB NOT NULL,

  -- AI metadata
  confidence NUMERIC,            -- 0..1
  risk TEXT CHECK (risk IN ('low','medium','high')),
  estimated_impact NUMERIC,      -- $ — informational

  -- Decision workflow
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending','accepted','modified','rejected','executed','failed')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  -- When decision='modified', the user-edited version of proposed_fix
  modified_fix JSONB,

  -- Execution tracking
  executed_at TIMESTAMPTZ,
  execution_result JSONB,
  execution_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bs_ai_fix_items_run
  ON bs_ai_fix_items(run_id);

CREATE INDEX IF NOT EXISTS idx_bs_ai_fix_items_client_pending
  ON bs_ai_fix_items(client_link_id, decision)
  WHERE decision = 'pending';

COMMENT ON COLUMN bs_ai_fix_items.proposed_fix IS
  'AI''s proposed fix. Shape depends on type: reclass_lines | journal_entry | flag_for_manual.';
COMMENT ON COLUMN bs_ai_fix_items.modified_fix IS
  'Populated when the bookkeeper edits the proposal before accepting. The finalize step uses this in preference to proposed_fix.';
