-- Migration 71 — Reclass AI work queue (chunked, resumable categorization).
-- =========================================================================
-- Big reclass discoveries used to run ALL AI categorization in one serverless
-- invocation and only write reclassifications at the very end — so a function
-- timeout mid-run lost everything (0 rows) and the job hung until the watchdog
-- failed it (e.g. James Painting LLC, 5.5-month range).
--
-- This queue makes AI categorization durable + resumable: after pre-matching,
-- every line that still needs Claude is enqueued here. The discovery worker
-- processes the queue in time-bounded chunks, writing real `reclassifications`
-- rows + deleting the queue entries as it goes. If a chunk hits its time
-- budget with rows remaining, the job pauses at status='ai_paused' and the
-- bookkeeper clicks Continue (→ /api/reclass/[id]/categorize-chunk) to run the
-- next chunk. No single invocation can exceed the function limit, and progress
-- is never lost.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists reclass_ai_queue (
  id bigserial primary key,
  reclass_job_id uuid not null references reclass_jobs(id) on delete cascade,
  ref_id text not null,        -- "<transaction_id>::<line_id>"
  payload jsonb not null,      -- the full ReclassLine (rebuilds AI input + row)
  created_at timestamptz not null default now()
);

-- FIFO dequeue per job.
create index if not exists reclass_ai_queue_job_idx
  on reclass_ai_queue(reclass_job_id, id);

-- Note: reclass_jobs.status is a free-text column (no DB enum/CHECK) — the new
-- 'ai_paused' value needs no schema change, same as the existing
-- 'web_search_paused'.
