-- Migration 135: COA-audit fleet scan cache + completion tracking (Mike 2026-07-18)
--
-- Backs /admin/coa-audit. Two goals:
--   1. Stop re-scanning the whole fleet on every page load — each per-client
--      scan is cached here (full drift payload + summary counts), so the page
--      hydrates instantly from the last scan and users only re-scan what's new
--      or stale.
--   2. Completion tracking — a client with < 4 outstanding issues after a scan
--      is "done" and drops to the Completed section, stamped with when it was
--      last scanned and by whom.
--
-- issue_count = wrong_type + missing_required + wrong_parent + merge_candidates
--   (the actionable set — matches the "Fix all (N)" badge; non-master banks /
--    assets / loans that are correctly left alone are NOT counted).
--
-- The page reads this defensively and degrades to "unscanned" if a row is
-- absent, so it works before this migration too. Apply to enable persistence.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists coa_audit_scans (
  client_link_id       uuid primary key references client_links(id) on delete cascade,
  conformance_pct      int    not null default 0,
  total_active         int    not null default 0,
  matched              int    not null default 0,
  wrong_type           int    not null default 0,
  non_master           int    not null default 0,
  missing_required     int    not null default 0,
  wrong_parent         int    not null default 0,
  merge_candidates     int    not null default 0,   -- proposals with action='merge'
  deleted_with_balance int    not null default 0,   -- retired accounts still carrying a balance
  stranded_cents       bigint not null default 0,   -- $ sitting on those deleted accounts
  issue_count          int    not null default 0,   -- actionable total (drives done/not-done)
  payload              jsonb,                        -- full scan response, for instant hydration
  scanned_at           timestamptz not null default now(),
  scanned_by           uuid references auth.users(id) on delete set null,
  scanned_by_name      text
);

create index if not exists idx_coa_audit_scans_issue_count
  on coa_audit_scans (issue_count);

comment on table coa_audit_scans is
  'Cached per-client COA-audit drift (see /admin/coa-audit). Upserted on every scan; read to hydrate the fleet view without re-hitting QuickBooks. issue_count < 4 => Completed.';

-- Service-role only: read + write happen through the admin API route and the
-- server component using the service client. No policies for `authenticated`,
-- so portal clients (also `authenticated`) can never see audit internals.
alter table coa_audit_scans enable row level security;

-- Verify:
--   select client_link_id, conformance_pct, issue_count, scanned_by_name, scanned_at
--   from coa_audit_scans order by scanned_at desc;
