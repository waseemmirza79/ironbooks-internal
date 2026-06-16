-- Migration 72 — Client billing metadata
-- =========================================
-- Adds billing fields to client_links so the portal billing page can show
-- the client's service tier, billing start date, and track cancel requests.
-- Stripe customer ID is stored here for linking to the customer portal.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table client_links
  add column if not exists service_tier text
    check (service_tier in ('insight', 'discipline', 'vision', 'scale')),
  add column if not exists stripe_customer_id text,
  add column if not exists billing_start_date date,
  add column if not exists billing_cancel_request_at timestamptz,
  add column if not exists billing_cancel_request_note text;

comment on column client_links.service_tier is
  'Ironbooks service tier: insight=$247, discipline=$497, vision=$797, scale=custom';
comment on column client_links.stripe_customer_id is
  'Stripe customer ID — used to open the billing portal and attribute coaching-call payments';
comment on column client_links.billing_start_date is
  'Date the engagement started (first month billed)';
comment on column client_links.billing_cancel_request_at is
  'When the client submitted a cancel request via the portal (does not auto-cancel)';
comment on column client_links.billing_cancel_request_note is
  'Reason the client provided with their cancel request';
