-- Migration 113: temporary manager-review gate on monthly close sends
--
-- Mike asked (2026-07-10) to add a manager-review step before this month's
-- P&Ls go out to clients. Columns are named generically (not after a specific
-- person) so the WHO is only ever decided in code — see the
-- MANAGER_REVIEW_EMAIL constant in app/api/clients/[id]/monthly-rec/route.ts.
--
-- THIS IS TEMPORARY. To remove later: drop these 3 columns (or just leave
-- them — nullable and unused is harmless) and delete the gate block in the
-- route (search "TEMPORARY: manager-review gate").
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table monthly_rec_runs add column if not exists manager_reviewed_by uuid references users(id);
alter table monthly_rec_runs add column if not exists manager_reviewed_at timestamptz;
-- {by, at, reason} — set when a senior sends WITHOUT the reviewer's sign-off
-- (she's out, etc). Same shape/spirit as the existing verification_override.
alter table monthly_rec_runs add column if not exists manager_review_override jsonb;

-- Verify
select column_name from information_schema.columns
where table_name = 'monthly_rec_runs' and column_name like 'manager_review%';
