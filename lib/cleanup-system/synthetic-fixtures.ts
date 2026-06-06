/**
 * Synthetic QBO-shaped fixtures for BS cleanup E2E tests.
 */

import type { OpenInvoice, UFPayment } from "@/lib/qbo-balance-sheet";

export const SYNTHETIC_CLIENT_NAME = "SYNTHETIC BS Cleanup Test Co";

export const syntheticUfPayments: UFPayment[] = [
  {
    qbo_payment_id: "pay-exact-001",
    customer_id: "cust-100",
    customer_name: "Acme Painting LLC",
    amount: 1500,
    date: "2026-05-15",
    memo: "Payment for invoice INV-1042",
    invoice_reference: "1042",
    already_applied: false,
  },
  {
    qbo_payment_id: "pay-high-002",
    customer_id: "cust-200",
    customer_name: "Blue Sky Homes",
    amount: 2200,
    date: "2026-05-18",
    memo: "Check deposit",
    invoice_reference: null,
    already_applied: false,
  },
  {
    qbo_payment_id: "pay-low-003",
    customer_id: "cust-300",
    customer_name: "Cornerstone Realty",
    amount: 800,
    date: "2026-05-20",
    memo: "Customer payment",
    invoice_reference: null,
    already_applied: false,
  },
  {
    qbo_payment_id: "pay-unmatched-004",
    customer_id: null,
    customer_name: null,
    amount: 99,
    date: "2026-05-21",
    memo: "Mystery deposit",
    invoice_reference: null,
    already_applied: false,
  },
];

export const syntheticOpenInvoices: OpenInvoice[] = [
  {
    qbo_invoice_id: "inv-1042",
    doc_number: "1042",
    customer_id: "cust-100",
    customer_name: "Acme Painting LLC",
    txn_date: "2026-05-01",
    balance: 1500,
    total_amount: 1500,
  },
  {
    qbo_invoice_id: "inv-2200a",
    doc_number: "2200-A",
    customer_id: "cust-200",
    customer_name: "Blue Sky Homes",
    txn_date: "2026-05-10",
    balance: 2200,
    total_amount: 2200,
  },
  {
    qbo_invoice_id: "inv-800a",
    doc_number: "800-A",
    customer_id: "cust-300",
    customer_name: "Cornerstone Realty",
    txn_date: "2026-05-12",
    balance: 800,
    total_amount: 800,
  },
  {
    qbo_invoice_id: "inv-800b",
    doc_number: "800-B",
    customer_id: "cust-300",
    customer_name: "Cornerstone Realty",
    txn_date: "2026-05-14",
    balance: 800,
    total_amount: 800,
  },
  // Duplicate pair for AR module
  {
    qbo_invoice_id: "inv-dup-old",
    doc_number: "5501",
    customer_id: "cust-400",
    customer_name: "Duplex Painters Inc",
    txn_date: "2026-04-01",
    balance: 950,
    total_amount: 950,
  },
  {
    qbo_invoice_id: "inv-dup-new",
    doc_number: "5501-R",
    customer_id: "cust-400",
    customer_name: "Duplex Painters Inc",
    txn_date: "2026-04-15",
    balance: 950,
    total_amount: 950,
  },
];

export const syntheticCrmCsv = `Job ID,Customer,Amount,Date,Status
JOB-5501,Duplex Painters Inc,950.00,2026-04-01,Completed
`;
