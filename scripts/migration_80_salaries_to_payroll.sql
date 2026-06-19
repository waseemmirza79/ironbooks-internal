-- Migration 80 — Master COA: standardize "salary/salaries" → "payroll"
-- =========================================================================
-- House style: we don't use the word "salaries" in account names — owner and
-- team compensation is all "payroll". Renames the remaining salary-named
-- master accounts. (Owner Draw / Salary is split separately in migration 79.)
--
-- Run AFTER migration 79, in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

update master_coa set account_name = 'Admin Team Payroll',            updated_at = now() where account_name = 'Admin Team Salaries';
update master_coa set account_name = 'Operations Manager Payroll',    updated_at = now() where account_name = 'Operations Manager Salary';
update master_coa set account_name = 'Sales Team Payroll/Commission',  updated_at = now() where account_name = 'Sales Team Salaries/Commission';
update master_coa set account_name = 'Payroll',                       updated_at = now() where account_name = 'Salaries & Payroll';
