-- Migration 82 — Master COA: workers comp (labour burden), CGL, vehicle nesting
-- =========================================================================
--   • Workers comp belongs in the labour COA as a labour burden (COGS / labor),
--     not an operating expense → move "Workman's Comp Insurance" there.
--   • Commercial General Liability as its own insurance line → rename
--     "General Liability Insurance" → "CGL Insurance".
--   • Vehicle insurance + vehicle loan interest sit under the Vehicle parent.
--
-- Run AFTER migrations 79–81, in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1) Workers comp = labour burden → move into the labour COGS, under Job Costs - Labor.
update master_coa
set qbo_account_type = 'Cost of Goods Sold',
    qbo_account_subtype = 'CostOfLabor',
    section = 'cogs',
    expense_category = 'cogs',
    parent_account_name = 'Job Costs - Labor',
    notes = 'Workers comp — labour burden (part of labour cost), in the COGS labour section.',
    updated_at = now()
where account_name = 'Workman''s Comp Insurance';

-- 2) CGL as its own insurance line item.
update master_coa
set account_name = 'CGL Insurance',
    notes = 'Commercial General Liability (CGL) insurance — its own insurance line.',
    updated_at = now()
where account_name = 'General Liability Insurance';

-- 3) Vehicle loan interest → sub-account under the Vehicle parent (matches the
--    other vehicle lines). Vehicle Insurance is already nested there.
update master_coa
set parent_account_name = 'Vehicle Expenses', updated_at = now()
where account_name = 'Vehicle Loan Interest';

-- Tidy: give Vehicle Insurance an expense category like its siblings.
update master_coa
set expense_category = 'general_operating', updated_at = now()
where account_name = 'Vehicle Insurance' and expense_category is null;
