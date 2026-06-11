-- Migration 63: cached AI dashboard narratives
--
-- The portal home page used to render a hand-built plain-English summary
-- of the closed month. We're upgrading to an AI-generated narrative that
-- also pulls from BS, A/R, A/P, cash, plus the painter-industry brief.
--
-- AI calls are expensive on a per-page-load basis (clients refresh the
-- portal often). Cache one narrative per (client_link_id, period_label)
-- so we generate it once per closed month and reuse it. When the closed
-- month rolls forward, the cache misses and we regenerate.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS portal_dashboard_narratives (
  client_link_id   UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  -- Period label as the resolver returns it (e.g. "April 2026"). Combined
  -- with client_link_id this is the cache key.
  period_label     TEXT NOT NULL,
  -- The closed-month end date — lets us detect when a regen is needed
  -- because the closed period changed (e.g. April → May).
  period_end       DATE NOT NULL,

  -- The structured narrative the AI returned. Shape:
  --   { headline: string, summary: string, coaching: string }
  -- Stored as JSONB so future shapes can extend without a migration.
  narrative        JSONB NOT NULL,

  -- Provenance — useful for debugging surprising outputs
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (client_link_id, period_label)
);

CREATE INDEX IF NOT EXISTS portal_dashboard_narratives_period_idx
  ON portal_dashboard_narratives (period_end DESC);
