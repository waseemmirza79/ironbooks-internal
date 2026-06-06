-- ============================================================================
-- Migration 55: Month-End Client Delivery
-- ============================================================================
-- Frozen month-end packages, fleet delivery runs, portal denormalized period,
-- and per-user notification dismissal for portal banner.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE month_end_package_status AS ENUM (
    'draft', 'summary_pending', 'ready_to_send', 'sending', 'sent', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE month_end_delivery_run_status AS ENUM (
    'running', 'complete', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Denormalized closed period for fast portal loads
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS latest_closed_period DATE;

COMMENT ON COLUMN client_links.latest_closed_period IS
  'End date of the most recently delivered closed month (set when month_end_packages.status=sent).';

-- Portal notification dismissal
ALTER TABLE client_users
  ADD COLUMN IF NOT EXISTS last_seen_package_id UUID;

COMMENT ON COLUMN client_users.last_seen_package_id IS
  'Dismisses the "statements ready" banner after the client views the package.';

CREATE TABLE IF NOT EXISTS month_end_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  period_year INT NOT NULL CHECK (period_year >= 2000 AND period_year <= 2100),
  period_month INT NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status month_end_package_status NOT NULL DEFAULT 'draft',
  pl_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  bs_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ar_ap_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  daily_recon_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_summary TEXT,
  ai_summary_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ai_summary_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ai_summary_reviewed_at TIMESTAMPTZ,
  portal_published_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  email_message_id TEXT,
  send_error TEXT,
  reclass_job_id UUID REFERENCES reclass_jobs(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_link_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_month_end_packages_status
  ON month_end_packages(status, period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_month_end_packages_ready
  ON month_end_packages(period_year, period_month, client_link_id)
  WHERE status = 'ready_to_send';

CREATE INDEX IF NOT EXISTS idx_month_end_packages_client
  ON month_end_packages(client_link_id, period_year DESC, period_month DESC);

COMMENT ON TABLE month_end_packages IS
  'Immutable frozen snapshot delivered to clients at month-end. Portal + email read from here, not live QBO.';

CREATE TABLE IF NOT EXISTS month_end_delivery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  status month_end_delivery_run_status NOT NULL DEFAULT 'running',
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  total_clients INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  error_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_month_end_delivery_runs_period
  ON month_end_delivery_runs(period_year, period_month, created_at DESC);

COMMENT ON TABLE month_end_delivery_runs IS
  'Fleet batch audit — one row per manager bulk-send action.';

-- RLS
ALTER TABLE month_end_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_end_delivery_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS month_end_packages_select ON month_end_packages;
CREATE POLICY month_end_packages_select ON month_end_packages
  FOR SELECT TO authenticated
  USING (user_can_see_client(auth.uid(), client_link_id));

DROP POLICY IF EXISTS month_end_delivery_runs_select ON month_end_delivery_runs;
CREATE POLICY month_end_delivery_runs_select ON month_end_delivery_runs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role IN ('admin', 'lead')
    )
  );
