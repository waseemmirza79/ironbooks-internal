import type { PeriodBounds } from "./types";

/**
 * A reclass job fully covers the target calendar month when its date range
 * spans from period start through period end (inclusive).
 */
export function reclassCoversPeriod(
  job: { date_range_start: string; date_range_end: string },
  period: PeriodBounds
): boolean {
  return (
    job.date_range_start <= period.periodStart &&
    job.date_range_end >= period.periodEnd
  );
}

export function pickBestReclassJob<
  T extends { id: string; date_range_start: string; date_range_end: string; status?: string }
>(jobs: T[], period: PeriodBounds): T | null {
  const covering = jobs.filter(
    (j) => j.status === "complete" && reclassCoversPeriod(j, period)
  );
  if (!covering.length) return null;
  covering.sort((a, b) => b.date_range_end.localeCompare(a.date_range_end));
  return covering[0];
}
