import type { DateRange, StockDatasetState } from "@intrinsic/domain";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

export function addDays(value: string, days: number): string {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date '${value}'`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Subtracts whole years from a `YYYY-MM-DD` date, clamping 29 February to 28 February.
 *
 * The one year arithmetic behind every historical bound — the retention horizon, the Stock
 * Details limit and the QA seed's coverage start — so they agree on every calendar day. Rolling a
 * leap day forward to 1 March instead would put a bound one day later than a clamp computed
 * elsewhere, and a coverage interval starting on the clamped day would then read as incomplete.
 */
export function subtractYears(value: string, years: number): string {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date '${value}'`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  const lastDayOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfMonth));
  return date.toISOString().slice(0, 10);
}

export function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function assertDateRange(range: DateRange): void {
  if (range.from && !isLocalDate(range.from)) {
    throw new Error(`Invalid from date '${range.from}'`);
  }
  if (range.to && !isLocalDate(range.to)) {
    throw new Error(`Invalid to date '${range.to}'`);
  }
  if (range.from && range.to && compareDates(range.from, range.to) > 0) {
    throw new Error("The from date must not be after the to date");
  }
}

export function missingDateRanges(
  requested: DateRange,
  state: Pick<StockDatasetState, "earliestDate" | "latestDate"> | null,
): DateRange[] {
  assertDateRange(requested);
  if (!state?.earliestDate || !state.latestDate) {
    return [{ ...requested }];
  }

  const missing: DateRange[] = [];
  if (requested.from && compareDates(requested.from, state.earliestDate) < 0) {
    const prefixTo = addDays(state.earliestDate, -1);
    missing.push({
      from: requested.from,
      to:
        requested.to && compareDates(requested.to, prefixTo) < 0
          ? requested.to
          : prefixTo,
    });
  }

  if (requested.to && compareDates(requested.to, state.latestDate) > 0) {
    const suffixFrom = addDays(state.latestDate, 1);
    missing.push({
      from:
        requested.from && compareDates(requested.from, suffixFrom) > 0
          ? requested.from
          : suffixFrom,
      to: requested.to,
    });
  }

  return missing;
}

export function missingCoverageRanges(
  requested: Required<DateRange>,
  coverage: readonly Required<DateRange>[],
): Required<DateRange>[] {
  assertDateRange(requested);
  const relevant = coverage
    .map((range) => {
      assertDateRange(range);
      return range;
    })
    .filter((range) => range.to >= requested.from && range.from <= requested.to)
    .sort((left, right) => left.from.localeCompare(right.from));

  const missing: Required<DateRange>[] = [];
  let cursor = requested.from;
  for (const covered of relevant) {
    if (covered.from > cursor) {
      missing.push({ from: cursor, to: addDays(covered.from, -1) });
    }
    if (covered.to >= cursor) {
      cursor = addDays(covered.to, 1);
    }
    if (cursor > requested.to) {
      break;
    }
  }
  if (cursor <= requested.to) {
    missing.push({ from: cursor, to: requested.to });
  }
  return missing;
}

/**
 * Advances a dataset watermark after a successful sync.
 *
 * Derived datasets carry no calculation version. A methodology change is an explicit rebuild that
 * changes the dataset variant, which starts a fresh watermark instead of widening an old one.
 */
export function advanceDatasetState(
  current: StockDatasetState | null,
  successfulCoverage: DateRange,
  lastSyncedAt: string,
): StockDatasetState {
  if (!successfulCoverage.from || !successfulCoverage.to) {
    throw new Error("Successful dataset coverage must be bounded");
  }
  assertDateRange(successfulCoverage);

  return {
    securityId: current?.securityId ?? "",
    dataset: current?.dataset ?? "DAILY_PRICE",
    earliestDate: !current?.earliestDate
      ? successfulCoverage.from
      : [current.earliestDate, successfulCoverage.from].sort()[0],
    latestDate: !current?.latestDate
      ? successfulCoverage.to
      : [current.latestDate, successfulCoverage.to].sort()[1],
    lastSyncedAt,
  };
}

export function endOfLocalDate(value: string): string {
  if (!isLocalDate(value)) {
    throw new Error(`Invalid local date '${value}'`);
  }
  return `${value}T23:59:59.999Z`;
}
