-- Migration 133 — master_coa: AccountSubType must belong to its AccountType's family
-- ============================================================================
-- Root cause of "created wrong, reported right" (Dominion, 2026-07-17): QBO
-- SILENTLY COERCES a new account's AccountType to match its AccountSubType's
-- family. Several master rows pair a type with a subtype from a DIFFERENT
-- family, so every account created from them lands in the wrong statement
-- section — and used accounts can't be retyped afterward via the API:
--
--   • 'CostOfLabor' is the EXPENSE enum; the COGS enum is 'CostOfLaborCos'.
--     Rows typed Cost of Goods Sold with 'CostOfLabor' get created as Expense.
--     (Bit Dominion: Direct Field Labor, Job Costs - Labor, Owner Labor (COGS),
--     Workers Compensation – Field, Employer CPP & EI – Field.)
--   • 'OtherCostsOfServiceCOGS' is not a QBO enum (casing) — valid is
--     'OtherCostsOfServiceCos'.
--   • 'OtherMiscellaneousExpense' / 'Depreciation' / 'PenaltiesSettlements' /
--     'ExchangeGainOrLoss' / 'Amortization' are OTHER-EXPENSE enums; on rows
--     typed 'Expense' they coerce creation to Other Expense. (Migration 118
--     introduced this for Incorporation/Recruiting; 115 for Penalties & Fines.)
--
-- The retype-rebuild engine (lib/coa-reclass-je.ts) now forces types as a
-- runtime backstop, but the master must stop minting mistyped accounts.
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

-- 1) COGS rows carrying the Expense labor enum → COGS labor enum.
update master_coa
   set qbo_account_subtype = 'CostOfLaborCos'
 where qbo_account_type = 'Cost of Goods Sold'
   and qbo_account_subtype = 'CostOfLabor';

-- 2) COGS rows with the bad-cased service enum.
update master_coa
   set qbo_account_subtype = 'OtherCostsOfServiceCos'
 where qbo_account_type = 'Cost of Goods Sold'
   and qbo_account_subtype in ('OtherCostsOfServiceCOGS', 'OtherCostsOfServiceCOGs');

-- 3) Expense rows carrying Other-Expense-family enums → generic valid Expense
--    enum (AccountType drives statement placement; DetailType is descriptive).
update master_coa
   set qbo_account_subtype = 'OtherBusinessExpenses'
 where qbo_account_type = 'Expense'
   and qbo_account_subtype in
       ('OtherMiscellaneousExpense', 'Depreciation', 'PenaltiesSettlements',
        'ExchangeGainOrLoss', 'Amortization');

-- 4) Sanity: nothing should remain in the known-bad pairings.
select account_name, industry, jurisdiction, qbo_account_type, qbo_account_subtype
  from master_coa
 where (qbo_account_type = 'Cost of Goods Sold'
        and qbo_account_subtype in ('CostOfLabor','OtherCostsOfServiceCOGS','OtherCostsOfServiceCOGs'))
    or (qbo_account_type = 'Expense'
        and qbo_account_subtype in ('OtherMiscellaneousExpense','Depreciation','PenaltiesSettlements',
                                    'ExchangeGainOrLoss','Amortization'));
