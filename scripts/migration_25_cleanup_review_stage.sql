-- Migration 25: senior-review stage between cleanup-done and complete
--
-- Today the cleanup pipeline jumps straight from "all stages run" to
-- "Completed Accounts" — there's no checkpoint where a senior reviews
-- the work + sends the PDF to the client before the cleanup-cycle is
-- officially closed and the client moves to month-over-month ops.
--
-- This migration adds an intermediate "in_review" stage:
--
--   Active cleanup → Submit for Review → In Review →
--     Approve & Send PDF → Complete (month-over-month)
--
-- Bookkeeper of any role submits; only admin/lead can approve. The
-- review_state column drives the partition on /clients (Active /
-- In Review / Completed) and the new "Pending Cleanup Reviews"
-- dashboard widget for seniors.
--
-- The existing cleanup_completed_at column keeps its current meaning
-- (the fully-complete timestamp). We add a separate review-submitted
-- timestamp + review-approved metadata.
--
-- Idempotent.

ALTER TABLE client_links
  -- Null = not in the review pipeline (either fresh client or fully
  -- completed). 'in_review' = bookkeeper submitted, awaiting senior.
  -- 'complete' (set by approval) becomes redundant with
  -- cleanup_completed_at being non-null, but it's convenient for the
  -- partition query — null state means "no review activity at all."
  ADD COLUMN IF NOT EXISTS cleanup_review_state text,

  -- When the bookkeeper submitted the cleanup for senior review.
  ADD COLUMN IF NOT EXISTS cleanup_review_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_review_submitted_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,

  -- When the senior approved (= cleanup_completed_at) and who.
  ADD COLUMN IF NOT EXISTS cleanup_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_reviewed_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Free-text notes the reviewer can leave (e.g. "asked client about
  -- the missing March deposit"). Surfaces in the Completed Accounts
  -- row + audit trail.
  ADD COLUMN IF NOT EXISTS cleanup_review_notes text;

-- Index for the "In Review" partition query.
CREATE INDEX IF NOT EXISTS idx_client_links_cleanup_review_state
  ON client_links (cleanup_review_state)
  WHERE cleanup_review_state IS NOT NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name LIKE 'cleanup_review%'
ORDER BY column_name;
