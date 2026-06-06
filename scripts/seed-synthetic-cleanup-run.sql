-- Synthetic BS Cleanup E2E seed for 1 Day Refinishing Edmonton LTD
-- Client: 1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26
-- Run after clearing prior test runs for this client.
-- Wizard: /balance-sheet/{client_id}/cleanup/{run_id}

-- Cleanup prior test data
DELETE FROM proposed_entries WHERE run_id IN (
  SELECT id FROM cleanup_runs WHERE client_link_id = '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26'
);
DELETE FROM cleanup_run_modules WHERE run_id IN (
  SELECT id FROM cleanup_runs WHERE client_link_id = '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26'
);
DELETE FROM bs_health_scores WHERE run_id IN (
  SELECT id FROM cleanup_runs WHERE client_link_id = '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26'
);
DELETE FROM cleanup_runs WHERE client_link_id = '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26';

INSERT INTO period_locks (client_link_id, lock_date, set_by)
VALUES ('1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', '2026-05-31', '6feb00ae-b7ab-455c-9b3e-b0fa0b248abc')
ON CONFLICT (client_link_id) DO UPDATE SET lock_date = EXCLUDED.lock_date, updated_at = now();

-- Use fixed run id for repeatable URLs (change if collision)
INSERT INTO cleanup_runs (
  id, client_link_id, bookkeeper_id, status, workflow_mode,
  period_lock_date, current_module
) VALUES (
  'de65f766-9955-465b-95a4-0c581d014add',
  '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26',
  '6feb00ae-b7ab-455c-9b3e-b0fa0b248abc',
  'reviewing', 'onboarding', '2026-05-31', 'undeposited_funds'
);

INSERT INTO cleanup_run_modules (run_id, module, status, proposed_count) VALUES
('de65f766-9955-465b-95a4-0c581d014add', 'bank_recon', 'reviewing', 3),
('de65f766-9955-465b-95a4-0c581d014add', 'undeposited_funds', 'reviewing', 4),
('de65f766-9955-465b-95a4-0c581d014add', 'accounts_receivable', 'reviewing', 2),
('de65f766-9955-465b-95a4-0c581d014add', 'accounts_payable', 'locked', 0),
('de65f766-9955-465b-95a4-0c581d014add', 'loans', 'locked', 0),
('de65f766-9955-465b-95a4-0c581d014add', 'shareholder_draws', 'locked', 0),
('de65f766-9955-465b-95a4-0c581d014add', 'tax_payroll', 'locked', 0),
('de65f766-9955-465b-95a4-0c581d014add', 'obe_uncategorized', 'locked', 0);

-- Bank recon (3 gap JEs)
INSERT INTO proposed_entries (run_id, client_link_id, module, entry_type, decision, confidence, amount, txn_date, memo, idempotency_key, period_impact, je_lines) VALUES
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'bank_recon', 'journal_entry', 'needs_review', 0.8, 8903.99, '2026-01-20', 'SYNTH Bank recon gap', 'syn:bank:1', 'clearing_entry', '[{"side":"debit","account_hint":"Chequing - 1278","amount":8903.99},{"side":"credit","account_hint":"Balance Sheet Cleanup Clearing","amount":8903.99}]'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'bank_recon', 'journal_entry', 'needs_review', 0.8, 1227.54, '2026-01-20', 'SYNTH Bank recon gap 2', 'syn:bank:2', 'clearing_entry', '[{"side":"debit","account_hint":"Chequing - 1278","amount":1227.54},{"side":"credit","account_hint":"Balance Sheet Cleanup Clearing","amount":1227.54}]'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'bank_recon', 'journal_entry', 'auto_approve', 0.85, 500, '2026-01-20', 'SYNTH small gap', 'syn:bank:3', 'clearing_entry', '[{"side":"debit","account_hint":"Chequing - 1278","amount":500},{"side":"credit","account_hint":"Balance Sheet Cleanup Clearing","amount":500}]');

-- UF module (4 synthetic payments — do NOT execute; QBO ids are fake)
INSERT INTO proposed_entries (run_id, client_link_id, module, entry_type, decision, confidence, amount, txn_date, memo, qbo_transaction_id, qbo_transaction_type, to_account_id, to_account_name, ai_reasoning, idempotency_key, period_impact) VALUES
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'undeposited_funds', 'receive_payment', 'auto_approve', 0.99, 1500, '2026-05-15', 'SYNTH exact', 'pay-exact-001', 'Payment', 'inv-1042', '1042', '{"v":1,"type":"uf_match","kind":"exact_invoice_number","reasoning":"exact","customer_name":"Acme Painting LLC","payment_id":"pay-exact-001","proposed_invoice_id":"inv-1042","proposed_doc_number":"1042","candidates":[{"qbo_invoice_id":"inv-1042","doc_number":"1042","balance":1500,"customer_name":"Acme Painting LLC","txn_date":"2026-05-01"}]}', 'syn:uf:1', 'current'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'undeposited_funds', 'receive_payment', 'auto_approve', 0.95, 2200, '2026-05-18', 'SYNTH high', 'pay-high-002', 'Payment', 'inv-2200a', '2200-A', '{"v":1,"type":"uf_match","kind":"high_confidence","reasoning":"high","customer_name":"Blue Sky Homes","payment_id":"pay-high-002","proposed_invoice_id":"inv-2200a","proposed_doc_number":"2200-A","candidates":[{"qbo_invoice_id":"inv-2200a","doc_number":"2200-A","balance":2200,"customer_name":"Blue Sky Homes","txn_date":"2026-05-10"}]}', 'syn:uf:2', 'current'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'undeposited_funds', 'receive_payment', 'needs_review', 0.6, 800, '2026-05-20', 'SYNTH low', 'pay-low-003', 'Payment', 'inv-800b', '800-B', '{"v":1,"type":"uf_match","kind":"low_confidence","reasoning":"pick","customer_name":"Cornerstone Realty","payment_id":"pay-low-003","proposed_invoice_id":"inv-800b","proposed_doc_number":"800-B","candidates":[{"qbo_invoice_id":"inv-800a","doc_number":"800-A","balance":800,"customer_name":"Cornerstone Realty","txn_date":"2026-05-12"},{"qbo_invoice_id":"inv-800b","doc_number":"800-B","balance":800,"customer_name":"Cornerstone Realty","txn_date":"2026-05-14"}]}', 'syn:uf:3', 'current'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'undeposited_funds', 'receive_payment', 'flagged', 0, 99, '2026-05-21', 'SYNTH unmatched', 'pay-unmatched-004', 'Payment', null, null, '{"v":1,"type":"uf_match","kind":"unmatched","reasoning":"manual","customer_name":null,"payment_id":"pay-unmatched-004","proposed_invoice_id":null,"proposed_doc_number":null,"candidates":[]}', 'syn:uf:4', 'current');

-- AR module (2 duplicate voids — fake QBO ids)
INSERT INTO proposed_entries (run_id, client_link_id, module, entry_type, decision, confidence, amount, txn_date, memo, qbo_transaction_id, qbo_transaction_type, to_account_id, to_account_name, ai_reasoning, idempotency_key, period_impact) VALUES
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'accounts_receivable', 'void', 'auto_approve', 0.92, 950, '2026-04-01', 'SYNTH dup void', 'inv-dup-old', 'Invoice', 'inv-dup-new', '5501-R', '{"v":1,"type":"ar_duplicate","reasoning":"dup","survivor_invoice_id":"inv-dup-new","survivor_doc_number":"5501-R","confidence":0.92}', 'syn:ar:1', 'current'),
('de65f766-9955-465b-95a4-0c581d014add', '1ec3d8b6-c7eb-4b24-b7aa-caa27a607b26', 'accounts_receivable', 'void', 'flagged', 0.5, 800, '2026-05-12', 'SYNTH heuristic dup', 'inv-800a', 'Invoice', 'inv-800b', '800-B', '{"v":1,"type":"ar_duplicate","reasoning":"heuristic","survivor_invoice_id":"inv-800b","survivor_doc_number":"800-B","confidence":0.5}', 'syn:ar:2', 'current');
