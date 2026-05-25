-- ============================================================================
-- Migration 40: Portal transaction flags
-- ============================================================================
-- Lets portal users (clients) flag a transaction they think looks wrong,
-- with a free-text note. Flags land in a queue the bookkeeper sees on the
-- Today tab. No QBO writes happen on flag — the bookkeeper reviews and
-- decides what to do.
--
-- Surfaces:
--   - Client portal: P&L drill-down drawer → "Flag this transaction" button
--   - Bookkeeper: /today page → "Client flags" widget at the top
--   - Resolution: bookkeeper marks acknowledged / applied / declined with
--     an optional reply note. No automated QBO action — bookkeeper handles
--     the actual reclass via existing flows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS portal_transaction_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  submitted_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Snapshot of the flagged transaction at submission time. Snapshots
  -- (not joins) because QBO can edit/delete the underlying txn before the
  -- bookkeeper gets to it — we still want to see what the client saw.
  qbo_txn_id TEXT,
  qbo_txn_type TEXT,
  qbo_account_id TEXT NOT NULL,
  account_label TEXT,
  txn_date DATE,
  txn_amount NUMERIC,
  txn_doc_number TEXT,
  txn_vendor_or_customer TEXT,
  txn_memo TEXT,
  /** Which P&L period the client was viewing when they flagged it. */
  period_label TEXT,
  period_start DATE,
  period_end DATE,

  /** The client's free-text note explaining the concern. */
  client_note TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_review','applied','declined','dismissed')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  /** Bookkeeper's reply / resolution note — visible to the client. */
  resolution_note TEXT,
  /** Optional pointer to a reclass_job that resulted from this flag, so the
   *  client can see "applied via Reclass Job X" when curious. */
  resolution_reclass_job_id UUID REFERENCES reclass_jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_txn_flags_client_status
  ON portal_transaction_flags(client_link_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_txn_flags_status_submitted
  ON portal_transaction_flags(status, submitted_at DESC);

COMMENT ON TABLE portal_transaction_flags IS
  'Client-submitted "this looks wrong" flags on individual transactions, queued for bookkeeper review. No QBO writes happen on submit — bookkeeper triages and decides.';
