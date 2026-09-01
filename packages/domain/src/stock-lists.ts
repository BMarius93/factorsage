import type { LocalDate } from "./stock-data.js";

/**
 * Buy eligibility of one security inside one stock list.
 *
 * `FULL` means the stock may be bought on any date a future strategy/backtest covers and carries
 * zero persisted ranges. `CUSTOM` restricts new BUYs to one or more configured date ranges.
 */
export const BUY_WINDOW_MODES = ["FULL", "CUSTOM"] as const;

export type BuyWindowMode = (typeof BUY_WINDOW_MODES)[number];

/**
 * One inclusive calendar-date buy range. `endDate` null means open-ended (continuing
 * indefinitely). An unrestricted stock uses mode `FULL` with no ranges, never a null `startDate`.
 */
export type BuyWindowRange = {
  readonly startDate: LocalDate;
  readonly endDate: LocalDate | null;
};

/** Complete buy-window configuration of one list item, as submitted or as persisted. */
export type BuyWindowConfiguration = {
  readonly mode: BuyWindowMode;
  readonly ranges: readonly BuyWindowRange[];
};

/** A submitted buy-window configuration that violates the product invariants. */
export class BuyWindowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuyWindowValidationError";
  }
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Structural + calendar validity, so 2023-02-31 is rejected, not silently rolled over. */
function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

function nextCalendarDay(value: LocalDate): LocalDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function assertValidRange(range: BuyWindowRange): void {
  if (typeof range.startDate !== "string" || !isValidLocalDate(range.startDate)) {
    throw new BuyWindowValidationError(
      "Every buy window needs a valid start date in YYYY-MM-DD form",
    );
  }
  if (range.endDate !== null) {
    if (typeof range.endDate !== "string" || !isValidLocalDate(range.endDate)) {
      throw new BuyWindowValidationError(
        "A buy-window end date must be a valid YYYY-MM-DD date or omitted for an open-ended window",
      );
    }
    if (range.startDate > range.endDate) {
      throw new BuyWindowValidationError(
        "A buy window cannot end before it starts",
      );
    }
  }
}

/**
 * Normalizes a complete set of CUSTOM buy ranges into the canonical persisted representation.
 *
 * The invariant: persisted ranges for one list item are always a canonical set of maximal,
 * chronologically sorted, non-overlapping and non-adjacent periods. Two inputs describing the
 * same eligible dates therefore always normalize to the identical output.
 *
 * Deterministic steps:
 * 1. validate every range (`startDate <= endDate` when bounded),
 * 2. sort chronologically by start date,
 * 3. merge overlapping ranges,
 * 4. merge directly adjacent ranges (one ends the calendar day before the next starts), because
 *    they represent one continuous eligibility period,
 * 5. an open-ended range absorbs every range at or after its start, so at most one survives and it
 *    is necessarily the final range.
 *
 * Merging never invents eligibility: the output covers exactly the union of the input dates
 * (adjacent days form one continuous period; no gap is closed and no range is broadened beyond
 * that union).
 */
export function normalizeBuyWindowRanges(
  ranges: readonly BuyWindowRange[],
): BuyWindowRange[] {
  for (const range of ranges) {
    assertValidRange(range);
  }

  const sorted = [...ranges].sort((left, right) => {
    if (left.startDate !== right.startDate) {
      return left.startDate < right.startDate ? -1 : 1;
    }
    // Same start: the open-ended (then the longer) range first, so the sweep below only ever has
    // to look at its most recently merged output.
    if (left.endDate === null || right.endDate === null) {
      return left.endDate === null ? (right.endDate === null ? 0 : -1) : 1;
    }
    return left.endDate > right.endDate ? -1 : left.endDate < right.endDate ? 1 : 0;
  });

  const merged: { startDate: LocalDate; endDate: LocalDate | null }[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...range });
      continue;
    }
    // An open-ended previous range reaches every later date, so it absorbs everything after it.
    if (previous.endDate === null) {
      continue;
    }
    // Overlap, containment, duplication, or direct adjacency all merge into one period.
    if (range.startDate <= nextCalendarDay(previous.endDate)) {
      if (range.endDate === null || range.endDate > previous.endDate) {
        previous.endDate = range.endDate;
      }
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}

/**
 * Validates and canonicalizes one complete submitted buy-window configuration.
 *
 * `FULL` must be submitted with zero ranges: silently discarding submitted ranges would hide a
 * client bug, so the mismatch is rejected instead. `CUSTOM` requires at least one range.
 */
export function normalizeBuyWindowConfiguration(
  configuration: BuyWindowConfiguration,
): BuyWindowConfiguration {
  if (configuration.mode === "FULL") {
    if (configuration.ranges.length > 0) {
      throw new BuyWindowValidationError(
        "A FULL buy window cannot carry ranges; switch to CUSTOM or submit no ranges",
      );
    }
    return { mode: "FULL", ranges: [] };
  }

  const ranges = normalizeBuyWindowRanges(configuration.ranges);
  if (ranges.length === 0) {
    throw new BuyWindowValidationError(
      "A CUSTOM buy window needs at least one date range",
    );
  }
  return { mode: "CUSTOM", ranges };
}
