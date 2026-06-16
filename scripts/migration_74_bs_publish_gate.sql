-- Migration 74 — Balance Sheet portal publish gate
-- =========================================================================
-- The client-portal Balance Sheet (and Cash Flow) now show ONLY when
-- client_links.bs_enabled = true. Previously they showed unless bs_enabled
-- was explicitly false — so a client mid-cleanup (bs_enabled = NULL) was
-- already seeing their un-cleaned balance sheet. The new rule: nothing shows
-- in the portal BS until a bookkeeper explicitly pushes it ("Publish Balance
-- Sheet to client portal" → sets bs_enabled = true).
--
-- This backfill keeps clients who are ALREADY live (so they don't suddenly
-- lose their balance sheet) visible: anyone on daily-recon, anyone whose
-- cleanup already completed, or any active/behind/paused client. New and
-- in-cleanup (onboarding) clients stay hidden until pushed.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

update client_links
set bs_enabled = true
where bs_enabled is null
  and (
    daily_recon_enabled = true
    or cleanup_completed_at is not null
    or status in ('active', 'behind', 'paused')
  );
