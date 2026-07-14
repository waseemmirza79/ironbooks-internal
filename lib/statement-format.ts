/**
 * Formatting for the statement views (bookkeeper card + portal panel) — kept
 * in one place so both sides show identical "Statement date" and
 * "Ending balance" columns. Pure + dependency-free (fixture-tested).
 */

const MONTHS_SHORT = [
  "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Last calendar day of a 1-indexed month (leap-year aware). */
export function lastDayOfMonth(year: number, month: number): number {
  if (month === 2 && isLeap(year)) return 29;
  return DAYS_IN_MONTH[month] ?? 31;
}

export interface StatementPeriodFields {
  statement_end_date: string | null; // "YYYY-MM-DD" (AI-parsed close date)
  period_month: number | null; // 1-12
  period_year: number | null;
}

/**
 * "Last statement date" = the last day of the statement's period. Prefer the
 * AI-parsed close date; otherwise the last calendar day of period_month/year
 * (or Dec 31 when only the year is known). Parsed from the string parts so a
 * "YYYY-MM-DD" value never shifts a day across timezones.
 */
export function statementEndLabel(s: StatementPeriodFields): string {
  const iso = (s.statement_end_date || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    const [, y, mo, d] = m;
    const month = Number(mo);
    return `${MONTHS_SHORT[month] || mo} ${Number(d)}, ${y}`;
  }
  if (s.period_year && s.period_month) {
    const day = lastDayOfMonth(s.period_year, s.period_month);
    return `${MONTHS_SHORT[s.period_month]} ${day}, ${s.period_year}`;
  }
  if (s.period_year) return `Dec 31, ${s.period_year}`;
  return "—";
}

/** Ending balance as currency, or an em dash when unknown. */
export function formatStatementBalance(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}$${abs}`;
}
