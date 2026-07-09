-- Migration 111: CPA round-trip + line-level bank clearing
--
-- Backs two features:
--   A. /clients/[id]/cpa — the CPA round-trip hub: paste the accountant's
--      closing trial balance and diff it against QBO; paste their AJEs and
--      post them; record filed tax amounts (GST/HST, source deductions, corp
--      tax) and tie them out to the ledger.
--   B. bank_recon_jobs line-level clearing columns (statement transaction
--      lines + outstanding/stale items from the statement-upload analysis).
--
-- All service-role-only (no authenticated policies — reads/writes go through
-- admin/lead-gated API routes). Idempotent.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- A1. CPA closing trial balances (one row per import)
create table if not exists cpa_tb_imports (
  id             uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  as_of_date     date not null,
  label          text,                       -- e.g. "FY2025 closing TB from Smith CPA"
  rows           jsonb not null,             -- [{account, amount}] debits positive
  row_count      int not null default 0,
  source_note    text,
  last_diff      jsonb,                      -- cached diff result (rows + summary + ran_at)
  created_by     uuid references users(id),
  created_at     timestamptz not null default now()
);
create index if not exists idx_cpa_tb_client on cpa_tb_imports (client_link_id, as_of_date desc);

-- A2. CPA adjusting-journal-entry batches
create table if not exists cpa_aje_batches (
  id             uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  label          text,
  entries        jsonb not null,             -- [{key, txn_date, memo, lines:[{account,debit,credit}], balanced}]
  entry_count    int not null default 0,
  posted_count   int not null default 0,
  post_results   jsonb,                      -- per-entry {key, status: posted|skipped|failed, qbo_je_id?, reason?}
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  posted_at      timestamptz
);
create index if not exists idx_cpa_aje_client on cpa_aje_batches (client_link_id, created_at desc);

-- A3. Filed statutory amounts (tie-out targets)
create table if not exists tax_filings (
  id             uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  filing_type    text not null check (filing_type in ('gst_hst','source_deductions','corp_tax')),
  period_start   date,
  period_end     date not null,
  filed_amount   numeric not null,           -- signed like the ledger (liability owed = negative)
  note           text,
  created_by     uuid references users(id),
  created_at     timestamptz not null default now()
);
create index if not exists idx_tax_filings_client on tax_filings (client_link_id, period_end desc);

alter table cpa_tb_imports  enable row level security;
alter table cpa_aje_batches enable row level security;
alter table tax_filings     enable row level security;

-- B. Line-level clearing on bank_recon_jobs
alter table bank_recon_jobs add column if not exists statement_lines    jsonb;
alter table bank_recon_jobs add column if not exists outstanding_items  jsonb;
alter table bank_recon_jobs add column if not exists line_match_summary jsonb;

-- Verify
select 'cpa_tb_imports' as tbl, count(*) from cpa_tb_imports
union all select 'cpa_aje_batches', count(*) from cpa_aje_batches
union all select 'tax_filings', count(*) from tax_filings;
