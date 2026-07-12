-- Migration 121 — industry-agnostic account labels
-- =========================================================================
-- The master chart is expanding beyond painters (HVAC, plumbers, etc.), so
-- three painting-specific account names become trade-generic. Run in the
-- Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new
--
-- Nothing else references these names (vendor KB has zero references). On each
-- client's next COA cleanup the engine proposes renaming their old account to
-- the new generic name; GIFI codes and types are unchanged.

update master_coa set account_name = 'Service Revenue'
 where account_name = 'Painting Revenue';

update master_coa set account_name = 'Direct Field Labor'
 where account_name = 'Direct Field Labor – Painting';

update master_coa set account_name = 'Subcontractors'
 where account_name = 'Subcontractors – Painting';

-- Sanity: no painting-specific names should remain.
select account_name, jurisdiction
  from master_coa
 where account_name ilike '%painting%' or account_name ilike '%– painting%';
