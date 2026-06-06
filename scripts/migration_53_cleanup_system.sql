-- ============================================================================
-- Migration 53: Balance Sheet Cleanup System
-- ============================================================================
-- Unified BS cleanup orchestrator, health scores, proposed entries staging,
-- CPA flags, and portal-deliverable reports. Extends existing BS module
-- tables with cleanup_run_id FK.
-- ============================================================================

-- ─── Enums ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE cleanup_run_status AS ENUM (
    'discovering', 'reviewing', 'executing', 'complete', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cleanup_workflow_mode AS ENUM ('onboarding', 'monthly_close');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cleanup_module AS ENUM (
    'bank_recon',
    'undeposited_funds',
    'accounts_receivable',
    'accounts_payable',
    'loans',
    'shareholder_draws',
    'tax_payroll',
    'obe_uncategorized'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cleanup_module_status AS ENUM (
    'locked', 'ready', 'discovering', 'reviewing', 'executing', 'complete', 'skipped', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE health_grade AS ENUM ('green', 'yellow', 'red');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE period_impact AS ENUM ('current', 'clearing_entry', 'cpa_blocked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE proposed_entry_type AS ENUM (
    'reclass', 'journal_entry', 'receive_payment', 'bill_payment', 'void', 'invoice'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cpa_flag_status AS ENUM ('open', 'signed_off', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE import_source AS ENUM ('bank', 'stripe', 'jobber', 'drip_jobs', 'loan_statement');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── period_locks ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS period_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  lock_date DATE NOT NULL,
  qbo_books_close_date DATE,
  double_close_date DATE,
  set_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_locks_client ON period_locks(client_link_id);

-- ─── qbo_snapshots ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS qbo_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  snapshot_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  as_of_date DATE NOT NULL,
  trial_balance JSONB NOT NULL DEFAULT '[]',
  balance_sheet JSONB NOT NULL DEFAULT '[]',
  account_balances JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qbo_snapshots_client ON qbo_snapshots(client_link_id);

-- ─── cleanup_runs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  bookkeeper_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status cleanup_run_status NOT NULL DEFAULT 'discovering',
  workflow_mode cleanup_workflow_mode NOT NULL DEFAULT 'onboarding',
  period_lock_id UUID REFERENCES period_locks(id) ON DELETE SET NULL,
  snapshot_id UUID REFERENCES qbo_snapshots(id) ON DELETE SET NULL,
  health_score_id UUID,
  current_module cleanup_module,
  period_lock_date DATE,
  discovery_cursor JSONB,
  attested BOOLEAN NOT NULL DEFAULT FALSE,
  attested_at TIMESTAMPTZ,
  attested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  qa_passed_at TIMESTAMPTZ,
  qa_results JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cleanup_runs_client_status ON cleanup_runs(client_link_id, status);

-- ─── cleanup_run_modules ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cleanup_run_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  module cleanup_module NOT NULL,
  status cleanup_module_status NOT NULL DEFAULT 'locked',
  proposed_count INT NOT NULL DEFAULT 0,
  approved_count INT NOT NULL DEFAULT 0,
  executed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, module)
);
CREATE INDEX IF NOT EXISTS idx_cleanup_run_modules_run ON cleanup_run_modules(run_id);

-- ─── bs_health_scores ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bs_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_id UUID REFERENCES cleanup_runs(id) ON DELETE SET NULL,
  snapshot_id UUID REFERENCES qbo_snapshots(id) ON DELETE SET NULL,
  overall_score INT NOT NULL DEFAULT 0 CHECK (overall_score >= 0 AND overall_score <= 100),
  overall_grade health_grade NOT NULL DEFAULT 'red',
  account_grades JSONB NOT NULL DEFAULT '[]',
  task_list JSONB NOT NULL DEFAULT '[]',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bs_health_scores_client ON bs_health_scores(client_link_id);
CREATE INDEX IF NOT EXISTS idx_bs_health_scores_run ON bs_health_scores(run_id);

ALTER TABLE cleanup_runs
  DROP CONSTRAINT IF EXISTS cleanup_runs_health_score_id_fkey;
ALTER TABLE cleanup_runs
  ADD CONSTRAINT cleanup_runs_health_score_id_fkey
  FOREIGN KEY (health_score_id) REFERENCES bs_health_scores(id) ON DELETE SET NULL;

-- ─── imported_records ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS imported_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_id UUID REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  source import_source NOT NULL,
  external_id TEXT NOT NULL,
  record_date DATE,
  payer_raw TEXT,
  payer_normalized TEXT,
  gross_amount NUMERIC,
  fee_amount NUMERIC DEFAULT 0,
  tax_amount NUMERIC DEFAULT 0,
  net_amount NUMERIC,
  reference TEXT,
  payout_id TEXT,
  currency TEXT DEFAULT 'CAD',
  record_type TEXT,
  raw_row JSONB,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_link_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_imported_records_run ON imported_records(run_id);
CREATE INDEX IF NOT EXISTS idx_imported_records_source ON imported_records(client_link_id, source);

-- ─── recon_matches ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recon_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  module cleanup_module NOT NULL,
  match_type TEXT NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  gross_amount NUMERIC,
  fee_amount NUMERIC DEFAULT 0,
  tax_amount NUMERIC DEFAULT 0,
  net_amount NUMERIC,
  proposed_fix JSONB,
  reasons JSONB NOT NULL DEFAULT '[]',
  source_record_ids UUID[],
  qbo_refs JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recon_matches_run ON recon_matches(run_id, module);

-- ─── cpa_flags ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cpa_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_id UUID REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL,
  description TEXT NOT NULL,
  impact_summary TEXT,
  status cpa_flag_status NOT NULL DEFAULT 'open',
  signed_off_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  signed_off_at TIMESTAMPTZ,
  sign_off_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cpa_flags_run ON cpa_flags(run_id);
CREATE INDEX IF NOT EXISTS idx_cpa_flags_client_status ON cpa_flags(client_link_id, status);

-- ─── proposed_entries ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposed_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  module cleanup_module NOT NULL,
  recon_match_id UUID REFERENCES recon_matches(id) ON DELETE SET NULL,
  entry_type proposed_entry_type NOT NULL,
  decision reclass_decision NOT NULL DEFAULT 'pending',
  confidence NUMERIC DEFAULT 0,
  ai_reasoning TEXT,
  period_impact period_impact NOT NULL DEFAULT 'current',
  skip_reason reclass_skip_reason,
  qbo_transaction_id TEXT,
  qbo_transaction_type TEXT,
  qbo_line_id TEXT,
  qbo_sync_token TEXT,
  from_account_id TEXT,
  from_account_name TEXT,
  to_account_id TEXT,
  to_account_name TEXT,
  je_lines JSONB,
  amount NUMERIC,
  txn_date DATE,
  memo TEXT,
  bookkeeper_override BOOLEAN NOT NULL DEFAULT FALSE,
  bookkeeper_override_target_id TEXT,
  bookkeeper_override_target_name TEXT,
  cpa_flag_id UUID REFERENCES cpa_flags(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  executed_at TIMESTAMPTZ,
  executed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  qbo_result_id TEXT,
  execution_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_proposed_entries_run ON proposed_entries(run_id, module);
CREATE INDEX IF NOT EXISTS idx_proposed_entries_decision ON proposed_entries(run_id, decision);

-- ─── cleanup_reports ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cleanup_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_id UUID REFERENCES cleanup_runs(id) ON DELETE SET NULL,
  health_score_id UUID REFERENCES bs_health_scores(id) ON DELETE SET NULL,
  report_data JSONB NOT NULL DEFAULT '{}',
  ai_summary TEXT,
  ai_summary_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ai_summary_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  published_to_portal BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cleanup_reports_client ON cleanup_reports(client_link_id);

-- ─── source_adapter_configs ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_adapter_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source import_source NOT NULL UNIQUE,
  column_map JSONB NOT NULL DEFAULT '{}',
  fee_rule JSONB,
  tax_handling JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default Stripe adapter config
INSERT INTO source_adapter_configs (source, column_map, fee_rule, tax_handling)
VALUES (
  'stripe',
  '{"external_id": "id", "date": "created_utc", "payer_raw": "description", "gross_amount": "gross", "fee_amount": "fee", "net_amount": "net", "reference": "payment_intent", "payout_id": "automatic_payout_id"}'::jsonb,
  '{"type": "stripe_standard", "fee_column": "fee"}'::jsonb,
  '{"type": "none"}'::jsonb
)
ON CONFLICT (source) DO NOTHING;

-- ─── Extend existing BS module tables ──────────────────────────────────────

ALTER TABLE bank_recon_jobs
  ADD COLUMN IF NOT EXISTS cleanup_run_id UUID REFERENCES cleanup_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bank_recon_jobs_cleanup_run ON bank_recon_jobs(cleanup_run_id);

ALTER TABLE uf_ar_jobs
  ADD COLUMN IF NOT EXISTS cleanup_run_id UUID REFERENCES cleanup_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_uf_ar_jobs_cleanup_run ON uf_ar_jobs(cleanup_run_id);

ALTER TABLE hardcore_cleanup_runs
  ADD COLUMN IF NOT EXISTS cleanup_run_id UUID REFERENCES cleanup_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hardcore_cleanup_runs_cleanup_run ON hardcore_cleanup_runs(cleanup_run_id);

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_run_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bs_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE recon_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpa_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleanup_reports ENABLE ROW LEVEL SECURITY;

-- Staff + portal read via user_can_see_client; writes staff-only
DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'period_locks', 'qbo_snapshots', 'cleanup_runs', 'cleanup_run_modules',
    'bs_health_scores', 'imported_records', 'recon_matches', 'proposed_entries',
    'cpa_flags', 'cleanup_reports'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_select ON %I FOR SELECT TO authenticated USING (user_can_see_client(auth.uid(), client_link_id))',
      t, t
    );
    -- cleanup_run_modules and recon_matches use run_id — join via cleanup_runs
    IF t IN ('cleanup_run_modules', 'recon_matches') THEN
      EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', t, t);
      EXECUTE format(
        'CREATE POLICY %I_select ON %I FOR SELECT TO authenticated USING (
          EXISTS (SELECT 1 FROM cleanup_runs cr WHERE cr.id = %I.run_id AND user_can_see_client(auth.uid(), cr.client_link_id))
        )', t, t, t
      );
    END IF;
  END LOOP;
END $$;
