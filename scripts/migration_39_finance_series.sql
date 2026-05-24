-- ============================================================================
-- Migration 39: Load the Finance fundamentals series + relax category check
-- ============================================================================
-- Two changes:
--
--   1. Drop the rigid CHECK constraint on learning_resources.category so
--      bookkeepers can add new series ("fundamentals", "advanced", etc.)
--      without a schema change. The portal Learn page has a default
--      "Other" fallback for unknown categories.
--
--   2. Wipe the placeholder seeds from migration 38 (they were never
--      customer-facing) and insert the 7-part Finance fundamentals series
--      with the real Vimeo URLs.
--
-- Finance 7 (Cash Flow) URL isn't provided yet — inserted with vimeo_url
-- NULL so it renders the "COMING SOON" badge until the URL is set:
--   UPDATE learning_resources SET vimeo_url='...' WHERE title LIKE 'Finance 7%';
-- ============================================================================

-- 1. Relax the category check. Existing rows already use only the old
--    six values so dropping it is safe.
ALTER TABLE learning_resources DROP CONSTRAINT IF EXISTS learning_resources_category_check;

-- 2. Wipe the placeholder seeds from migration 38. They had vimeo_url=NULL
--    and were never linked to real content. Safe to remove.
DELETE FROM learning_resources WHERE vimeo_url IS NULL AND youtube_url IS NULL AND video_url IS NULL;

-- 3. Insert the Finance fundamentals series. Sort order matches the
--    numbering so they appear as a sequenced course.
INSERT INTO learning_resources (title, description, category, vimeo_url, sort_order)
VALUES
  (
    'Finance 1 — Introduction to Finance',
    'The starting point. What "finance" actually means for a small business and why these next 6 videos matter.',
    'fundamentals',
    'https://vimeo.com/1175007969/053cb38f91',
    10
  ),
  (
    'Finance 2 — Financial Statements',
    'The three statements every business owner should be able to read: Profit & Loss, Balance Sheet, and Cash Flow.',
    'fundamentals',
    'https://vimeo.com/1175008080/d777ed766b',
    20
  ),
  (
    'Finance 3 — Your Relationship With Money',
    'The mindset side. How owners get tripped up by their own thinking — and how to keep money decisions clear-headed.',
    'fundamentals',
    'https://vimeo.com/1175008140/4535d9aeb6',
    30
  ),
  (
    'Finance 4 — Job Costing',
    'The discipline most painters skip. How to know which jobs actually make money and how to price the next one accurately.',
    'fundamentals',
    'https://vimeo.com/1175008166/2761a015c9',
    40
  ),
  (
    'Finance 5 — Bookkeeping vs. Accounting',
    'They sound the same. They aren''t. What each role does, when you need both, and what to expect from your bookkeeper.',
    'fundamentals',
    'https://vimeo.com/1175008238/e7cb5fe265',
    50
  ),
  (
    'Finance 6 — Consumer Debt',
    'When debt helps and when it hurts — for the business AND for you personally. Includes the math on when a loan is worth it.',
    'fundamentals',
    'https://vimeo.com/1175009255/6b7c6d10da',
    60
  ),
  (
    'Finance 7 — Cash Flow',
    'Why profitable businesses still run out of cash, and the weekly habit that catches problems before they snowball.',
    'fundamentals',
    NULL,  -- vimeo_url to be filled in once recorded; renders as COMING SOON
    70
  )
ON CONFLICT DO NOTHING;
