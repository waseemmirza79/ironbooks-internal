-- Migration 78 — Grain match exclusions (durable "unlink")
-- =========================================================================
-- When a bookkeeper/admin (or client) unlinks a call from a client, we both
-- delete the match row AND record an exclusion here. The backfill/auto-match
-- checks this table so the call doesn't silently re-attach on the next run.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists grain_match_exclusions (
  recording_id text not null references grain_recordings(id) on delete cascade,
  client_link_id uuid not null references client_links(id) on delete cascade,
  excluded_by uuid references users(id),
  excluded_at timestamptz not null default now(),
  primary key (recording_id, client_link_id)
);

create index if not exists grain_match_excl_client_idx on grain_match_exclusions(client_link_id);

comment on table grain_match_exclusions is
  'Recording↔client pairs a human explicitly unlinked. Auto-matching must skip these.';
