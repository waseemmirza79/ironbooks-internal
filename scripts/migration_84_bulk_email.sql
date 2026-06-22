-- Migration 84 — Bulk email: consent, campaigns, recipients, templates, bounces
-- =========================================================================
-- Supports emailing some/all clients at once with two kinds:
--   • operational — must-receive, ignores unsubscribe
--   • normal      — marketing; respects unsubscribe + carries an unsub footer
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- ── Per-client consent + deliverability flags ────────────────────────────
alter table client_links
  add column if not exists marketing_subscribed   boolean not null default true,
  add column if not exists marketing_unsubscribed_at timestamptz,
  add column if not exists marketing_unsub_source  text,        -- 'link' | 'admin' | 'bounce'
  add column if not exists email_hard_bounced      boolean not null default false,
  add column if not exists email_bounced_at        timestamptz,
  add column if not exists email_bounce_reason      text,
  add column if not exists last_bulk_emailed_at     timestamptz; -- "last emailed" indicator

-- ── Campaigns ────────────────────────────────────────────────────────────
create table if not exists bulk_email_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body_html text not null,            -- composer body (pre-wrap); branded at send
  kind text not null check (kind in ('operational','normal','resubscribe')),
  reply_to_mode text not null default 'bookkeeper', -- 'bookkeeper' | 'support'
  created_by uuid references users(id),
  status text not null default 'draft', -- draft | sending | sent | failed
  recipient_count int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists bulk_email_campaigns_created_idx on bulk_email_campaigns(created_at desc);

-- ── Per-recipient log (audit + retry) ────────────────────────────────────
create table if not exists bulk_email_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references bulk_email_campaigns(id) on delete cascade,
  client_link_id uuid references client_links(id) on delete set null,
  email text not null,
  status text not null default 'pending', -- pending | sent | failed | skipped
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists bulk_email_recipients_campaign_idx on bulk_email_recipients(campaign_id);
create index if not exists bulk_email_recipients_client_idx on bulk_email_recipients(client_link_id);

-- ── Reusable templates ───────────────────────────────────────────────────
create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body_html text not null,
  kind text not null default 'normal' check (kind in ('operational','normal','resubscribe')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
