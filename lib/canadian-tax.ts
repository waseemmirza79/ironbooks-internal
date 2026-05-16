/**
 * Canadian sales tax rates by province/territory.
 *
 * Used by:
 *  - The new-job form (display tax rates when a Canadian province is selected)
 *  - The reclass executor (apply tax codes to QBO bank rules for Canadian clients)
 *
 * Rates current as of 2026. US clients skip tax entirely.
 */

export interface ProvinceTax {
  /** Two-letter Canadian province/territory code (ON, BC, etc.) */
  code: string;
  name: string;
  /** Display string: "13% HST", "5% GST + 7% PST", etc. */
  display: string;
  /** Individual rate components (decimal: 0.13 = 13%) */
  rates: {
    gst?: number;
    hst?: number;
    pst?: number;
    rst?: number;
    qst?: number;
  };
  /** Combined effective rate (decimal) */
  combined: number;
}

export const CANADIAN_PROVINCES: ProvinceTax[] = [
  { code: "AB", name: "Alberta",                   display: "5% GST",            rates: { gst: 0.05 },                  combined: 0.05 },
  { code: "BC", name: "British Columbia",          display: "5% GST + 7% PST",   rates: { gst: 0.05, pst: 0.07 },       combined: 0.12 },
  { code: "MB", name: "Manitoba",                  display: "5% GST + 7% RST",   rates: { gst: 0.05, rst: 0.07 },       combined: 0.12 },
  { code: "NB", name: "New Brunswick",             display: "15% HST",           rates: { hst: 0.15 },                  combined: 0.15 },
  { code: "NL", name: "Newfoundland & Labrador",   display: "15% HST",           rates: { hst: 0.15 },                  combined: 0.15 },
  { code: "NS", name: "Nova Scotia",               display: "15% HST",           rates: { hst: 0.15 },                  combined: 0.15 },
  { code: "ON", name: "Ontario",                   display: "13% HST",           rates: { hst: 0.13 },                  combined: 0.13 },
  { code: "PE", name: "Prince Edward Island",      display: "15% HST",           rates: { hst: 0.15 },                  combined: 0.15 },
  { code: "QC", name: "Quebec",                    display: "5% GST + 9.975% QST", rates: { gst: 0.05, qst: 0.09975 },  combined: 0.14975 },
  { code: "SK", name: "Saskatchewan",              display: "5% GST + 6% PST",   rates: { gst: 0.05, pst: 0.06 },       combined: 0.11 },
  // Territories
  { code: "NT", name: "Northwest Territories",     display: "5% GST",            rates: { gst: 0.05 },                  combined: 0.05 },
  { code: "NU", name: "Nunavut",                   display: "5% GST",            rates: { gst: 0.05 },                  combined: 0.05 },
  { code: "YT", name: "Yukon",                     display: "5% GST",            rates: { gst: 0.05 },                  combined: 0.05 },
];

export function getProvinceTax(code: string | null | undefined): ProvinceTax | undefined {
  if (!code) return undefined;
  return CANADIAN_PROVINCES.find((p) => p.code === code.toUpperCase());
}
