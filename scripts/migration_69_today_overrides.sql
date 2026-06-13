-- Migration 69: manager controls for the Today queue.
-- One row per actionable item (keyed by a stable item_key the widgets
-- build, e.g. "escalation:<audit_id>"). Lets a manager resolve/hide an
-- item and assign a due date; the Today page applies these on read.
-- Global per item (shared manager queue) — not per-user.
CREATE TABLE IF NOT EXISTS today_item_overrides (
  item_key     text PRIMARY KEY,
  resolved_at  timestamptz,
  hidden_at    timestamptz,
  due_date     date,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
