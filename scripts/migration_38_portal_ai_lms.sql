-- ============================================================================
-- Migration 38: Portal AI usage tracking + LMS learning resources
-- ============================================================================
-- Two additions for portal Days 6 + 7:
--
--   1. portal_ai_usage — one row per client_link per day, tracks message
--      count for the soft rate limit (default 50/day/client). Reset at
--      midnight UTC; the API route increments via UPSERT.
--
--   2. learning_resources — the LMS content library. Bookkeepers (admin/
--      lead) populate via SQL or a future admin UI. The portal Learn page
--      reads this directly. Per-user progress tracking deferred to a
--      follow-up if clients ask for it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS portal_ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  message_count INTEGER NOT NULL DEFAULT 0,
  -- Tally tokens too — handy for cost telemetry even if we don't show it
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (user, day). UPSERT-friendly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_ai_usage_user_day
  ON portal_ai_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS idx_portal_ai_usage_client_day
  ON portal_ai_usage(client_link_id, usage_date DESC);

COMMENT ON TABLE portal_ai_usage IS
  'Daily message tally per portal user for soft rate-limiting + cost telemetry. One row per (user_id, usage_date).';


CREATE TABLE IF NOT EXISTS learning_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general','statements','cashflow','taxes','growth','quickstart')),
  -- Embed source. We support Vimeo + YouTube + raw mp4 by URL pattern;
  -- the player component decides which renderer to use.
  vimeo_url TEXT,
  youtube_url TEXT,
  video_url TEXT,         -- raw mp4 or external player URL
  thumbnail_url TEXT,     -- optional poster image (Vimeo / YouTube auto-generate one too)
  duration_seconds INTEGER,
  -- Optional downloadable companion file (PDF cheat sheet, etc.)
  download_url TEXT,
  download_label TEXT,
  -- Sort + visibility controls — bookkeepers can hide a video without deleting
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_resources_active_sort
  ON learning_resources(is_active, sort_order, created_at);

COMMENT ON TABLE learning_resources IS
  'LMS content library for the client portal. Populated by bookkeepers via SQL (or future admin UI). The portal /portal/learn page reads is_active=true rows in sort_order.';


-- Seed 10 placeholder rows so the Learn page renders something on first
-- deploy. Bookkeepers swap these for real Vimeo URLs as the videos get
-- produced. Safe to re-run — uses unique on title to prevent dupes.
INSERT INTO learning_resources (title, description, category, vimeo_url, duration_seconds, sort_order)
VALUES
  ('Reading your Profit & Loss', 'A 5-minute walkthrough of how to read your P&L statement — what each section means and which numbers actually matter.', 'statements', NULL, 300, 10),
  ('Reading your Balance Sheet', 'The "what you own / owe / yours" view, explained simply. Includes the math behind net worth.', 'statements', NULL, 280, 20),
  ('Why your bank balance doesn''t match your books', 'The most common confusion — and why it''s usually not a problem.', 'statements', NULL, 320, 30),
  ('Cash flow basics: profitable but cash-poor', 'How a profitable business can still run out of cash, and how to spot it before it bites.', 'cashflow', NULL, 380, 40),
  ('Setting aside for taxes', 'A simple rule of thumb for how much to set aside, and the timing of quarterly payments.', 'taxes', NULL, 290, 50),
  ('Pricing jobs to actually be profitable', 'A common pricing mistake painters make and how to fix it.', 'growth', NULL, 470, 60),
  ('When to pay yourself vs reinvest', 'Owner draws explained, with a framework for deciding how much to take.', 'growth', NULL, 410, 70),
  ('Reading your A/R Aging report', 'Who owes you, how long they''ve owed you, and when to follow up.', 'statements', NULL, 250, 80),
  ('How to read your books in 5 minutes a week', 'A weekly habit that catches problems before they snowball.', 'quickstart', NULL, 260, 90),
  ('Talking to your bookkeeper effectively', 'The questions worth asking and the questions to bring to your CPA instead.', 'quickstart', NULL, 240, 100)
ON CONFLICT DO NOTHING;
