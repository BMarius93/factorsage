import {
  BACKTEST_INVALID_CODE,
  BACKTEST_MAX_INITIAL_CAPITAL,
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_MONTHLY_CONTRIBUTION,
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_MIN_INITIAL_CAPITAL,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Envelope parsing for the backtest routes.
 *
 * Hand-written, matching the repository's existing approach — there is no validation library in
 * the workspace and none should be added. Every bound comes from `@intrinsic/contracts`, so the
 * submission form and the API cannot disagree about what is submittable.
 *
 * This layer checks the envelope only. Whether the strategy, list and benchmark exist, and whether
 * the list is usable, is ownership-scoped state the service resolves; it is not knowable here.
 *
 * **Rejecting unknown keys is a real rule, not tidiness.** A run's inputs are snapshotted and
 * become immutable, so a silently ignored field would be invisible in the reproducibility record.
 */

/** Generous structural bound; real ids are 36-character UUIDs. */
const MAX_ID_LENGTH = 64;
/** Codes are short product identifiers such as `SP500`, never free text. */
const MAX_BENCHMARK_CODE_LENGTH = 32;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every rejected submission answers with the one stable code, so the Backtest form can tell a
 * rejected configuration from an infrastructure failure without parsing prose.
 */
export function backtestInvalid(message: string): BadRequestException {
  return new BadRequestException({ message, code: BACKTEST_INVALID_CODE });
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw backtestInvalid("Invalid request body");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw backtestInvalid(
        `Invalid request: \`${key}\` is not part of a backtest configuration.`,
      );
    }
  }
}

function parseId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw backtestInvalid(`Select a ${label} to run this backtest against`);
  }
  return value.trim();
}

/** Structural *and* calendar validity, so 2023-02-31 is rejected rather than rolled over. */
function parseCalendarDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
    throw backtestInvalid(
      `A backtest needs a valid ${label} in YYYY-MM-DD form`,
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw backtestInvalid(
      `A backtest needs a valid ${label} in YYYY-MM-DD form`,
    );
  }
  return value;
}

function parseAmount(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw backtestInvalid(`A backtest needs a ${label} amount`);
  }
  if (value < minimum || value > maximum) {
    throw backtestInvalid(
      `A backtest ${label} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** The calendar date `years` after `date`, used as the inclusive upper bound of a period. */
function addYears(date: string, years: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted.toISOString().slice(0, 10);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export type ParsedCreateBacktestRunRequest = {
  strategyId: string;
  stockListId: string;
  /** Absent means the caller accepts the product default; the service resolves which that is. */
  benchmarkCode?: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  /** Normalized here: an omitted contribution is zero, so the snapshot records an explicit value. */
  monthlyContribution: number;
  maximumPositions: number;
};

export function parseCreateBacktestRunRequest(
  body: unknown,
): ParsedCreateBacktestRunRequest {
  const record = asRecord(body);
  rejectUnknownKeys(record, [
    "strategyId",
    "stockListId",
    "benchmarkCode",
    "startDate",
    "endDate",
    "initialCapital",
    "monthlyContribution",
    "maximumPositions",
  ]);

  const startDate = parseCalendarDate(record.startDate, "start date");
  const endDate = parseCalendarDate(record.endDate, "end date");
  if (startDate >= endDate) {
    throw backtestInvalid("A backtest period must start before it ends");
  }
  // A period that has not happened yet cannot be simulated, and the future half of one would
  // silently shorten the run instead of reporting that the request was wrong.
  if (endDate > todayIsoDate()) {
    throw backtestInvalid("A backtest period cannot end in the future");
  }
  if (endDate > addYears(startDate, BACKTEST_MAX_PERIOD_YEARS)) {
    throw backtestInvalid(
      `A backtest period can cover at most ${BACKTEST_MAX_PERIOD_YEARS} years`,
    );
  }

  const maximumPositions = record.maximumPositions;
  if (
    typeof maximumPositions !== "number" ||
    !Number.isInteger(maximumPositions) ||
    maximumPositions < BACKTEST_MIN_MAXIMUM_POSITIONS ||
    maximumPositions > BACKTEST_MAX_MAXIMUM_POSITIONS
  ) {
    throw backtestInvalid(
      `Maximum positions must be a whole number between ${BACKTEST_MIN_MAXIMUM_POSITIONS} and ${BACKTEST_MAX_MAXIMUM_POSITIONS}`,
    );
  }

  const benchmarkCode =
    record.benchmarkCode === undefined
      ? undefined
      : parseBenchmarkCode(record.benchmarkCode);

  return {
    strategyId: parseId(record.strategyId, "strategy"),
    stockListId: parseId(record.stockListId, "stock list"),
    ...(benchmarkCode === undefined ? {} : { benchmarkCode }),
    startDate,
    endDate,
    initialCapital: parseAmount(
      record.initialCapital,
      "initial capital",
      BACKTEST_MIN_INITIAL_CAPITAL,
      BACKTEST_MAX_INITIAL_CAPITAL,
    ),
    monthlyContribution:
      record.monthlyContribution === undefined
        ? 0
        : parseAmount(
            record.monthlyContribution,
            "monthly contribution",
            0,
            BACKTEST_MAX_MONTHLY_CONTRIBUTION,
          ),
    maximumPositions,
  };
}

function parseBenchmarkCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_BENCHMARK_CODE_LENGTH
  ) {
    throw backtestInvalid(
      "Select a benchmark to compare this backtest against",
    );
  }
  return value.trim();
}
