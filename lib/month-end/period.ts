import type { PeriodBounds, PeriodRef } from "./types";

/** Previous calendar month — default M/E target on the 1st of a new month. */
export function defaultDeliveryPeriod(asOf = new Date()): PeriodRef {
  const d = new Date(asOf.getFullYear(), asOf.getMonth() - 1, 1);
  return { periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1 };
}

export function periodBounds(ref: PeriodRef): PeriodBounds {
  const { periodYear, periodMonth } = ref;
  const start = new Date(periodYear, periodMonth - 1, 1);
  const end = new Date(periodYear, periodMonth, 0);
  return {
    periodYear,
    periodMonth,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

export function priorPeriod(ref: PeriodRef): PeriodRef {
  const d = new Date(ref.periodYear, ref.periodMonth - 2, 1);
  return { periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1 };
}

export function parsePeriodQuery(
  yearRaw?: string | null,
  monthRaw?: string | null
): PeriodRef {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12) {
    return { periodYear: year, periodMonth: month };
  }
  return defaultDeliveryPeriod();
}
