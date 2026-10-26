import {
  addYears,
  BACKTEST_INVALID_CODE,
  type UpdateBacktestShareRequest,
  BACKTEST_TRADE_ACTIONS,
  BACKTEST_TRADE_DEFAULT_ORDER,
  BACKTEST_TRADE_ORDERS,
  BACKTEST_RUN_QUERY_MAX_LENGTH,
  BACKTEST_RUN_SORTS,
  BACKTEST_RUN_STATUS_FILTERS,
  type BacktestRunSort,
  type BacktestRunStatusFilter,
  type BacktestTradeAction,
  type BacktestTradeOrder,
  BACKTEST_MAX_INITIAL_CAPITAL,
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_MONTHLY_CONTRIBUTION,
  BACKTEST_MAX_PERIOD_YEARS,
  BACKTEST_MIN_INITIAL_CAPITAL,
  BACKTEST_MIN_MAXIMUM_POSITIONS,
  newYorkDate,
  subtractYears,
} from "@intrinsic/contracts";
import { getEodFinalityConfig } from "@intrinsic/config";
import { eodCutoffDate, type LocalDate } from "@intrinsic/domain";
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

/**
 * The two dates a submission is judged against.
 *
 * `today` is the New York trading day: a period ending after it has not happened yet.
 * `finalizedThrough` is the newest date whose end-of-day bar is final (`eodCutoffDate`): a period
 * that reaches past it would simulate a session that is still trading, or whose bar the provider is
 * still publishing, so it is ended there (`docs/decisions/eod-finality-v1.md`).
 */
export type BacktestSubmissionClock = {
  readonly today: LocalDate;
  readonly finalizedThrough: LocalDate;
};

export function currentBacktestSubmissionClock(
  now: Date = new Date(),
): BacktestSubmissionClock {
  return {
    // The browser's New Backtest form defaults its end date with the same function.
    today: newYorkDate(now),
    finalizedThrough: eodCutoffDate(
      now,
      getEodFinalityConfig().publicationDelayMs,
    ),
  };
}

/**
 * The earliest date a backtest may start today.
 *
 * The same day the New Backtest form offers as its `MIN`, computed from the same shared
 * `subtractYears` so the browser and the API cannot disagree about it.
 */
export function earliestSelectableBacktestStart(today: string): string {
  return subtractYears(today, BACKTEST_MAX_PERIOD_YEARS);
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
  /** Injectable so the horizon boundary is testable; production reads the real clock. */
  clock: BacktestSubmissionClock = currentBacktestSubmissionClock(),
): ParsedCreateBacktestRunRequest {
  const { today, finalizedThrough } = clock;
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
  const requestedEnd = parseCalendarDate(record.endDate, "end date");
  if (startDate >= requestedEnd) {
    throw backtestInvalid("A backtest period must start before it ends");
  }
  // A period that has not happened yet cannot be simulated, and the future half of one would
  // silently shorten the run instead of reporting that the request was wrong.
  if (requestedEnd > today) {
    throw backtestInvalid("A backtest period cannot end in the future");
  }
  // Today, while its session is still trading or its bar is still being published, is not part of
  // the market's history yet. The period ends at the newest finalized session instead, and the
  // snapshot records exactly that — the run never simulates a provisional bar, and its record says
  // which day it really ended on.
  const endDate =
    requestedEnd > finalizedThrough ? finalizedThrough : requestedEnd;
  if (startDate >= endDate) {
    throw backtestInvalid(
      `A backtest period must start before ${finalizedThrough}, the newest completed trading session`,
    );
  }
  if (endDate > addYears(startDate, BACKTEST_MAX_PERIOD_YEARS)) {
    throw backtestInvalid(
      `A backtest period can cover at most ${BACKTEST_MAX_PERIOD_YEARS} years`,
    );
  }
  // And the *start* has to be inside the horizon the product actually keeps, not merely within
  // thirty years of the end. Without this a caller could submit an old but short period — 1985 to
  // 1990 — which no data exists for, and the loader would quietly narrow it at execution time to
  // whatever the current clock allowed. The run would complete, report a period it did not
  // simulate, and be irreproducible tomorrow. It is refused here instead, where the caller can
  // see it.
  const earliest = earliestSelectableBacktestStart(finalizedThrough);
  if (startDate < earliest) {
    throw backtestInvalid(
      `A backtest cannot start before ${earliest}: the product keeps ${BACKTEST_MAX_PERIOD_YEARS} ` +
        "years of history",
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

/**
 * `?page=` and `?pageSize=` on the trade log, plus its filter and order
 * ({@link parseTradeLogQuery}).
 *
 * Deliberately forgiving where a rejection would help nobody: a missing, malformed or
 * out-of-range value falls back to the default rather than answering `400`, and the service
 * clamps a page past the end to the last real one. A bookmark to page 400 of a run that has since
 * been re-read should land on its last page, not on an error — and there is no state to corrupt
 * here, which is what makes leniency safe on this route and wrong on submission.
 */
export function parseTradePageRequest(query: {
  page?: unknown;
  pageSize?: unknown;
  symbol?: unknown;
  action?: unknown;
  order?: unknown;
}): ParsedTradePageRequest {
  const page = parsePositiveInteger(query.page);
  const pageSize = parsePositiveInteger(query.pageSize);
  return {
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...parseTradeLogQuery(query),
  };
}

/** A traded symbol is a short ticker; anything longer cannot name one and is ignored. */
const MAX_TRADE_SYMBOL_LENGTH = 32;

export type ParsedTradeLogQuery = {
  symbol?: string;
  action?: BacktestTradeAction;
  order: BacktestTradeOrder;
};

export type ParsedTradePageRequest = ParsedTradeLogQuery & {
  page?: number;
  pageSize?: number;
};

/**
 * `?symbol=`, `?action=` and `?order=` on the trade log and on its CSV export.
 *
 * One parser for both routes on purpose: the export is "the log I am looking at, as a file", so a
 * query string must mean exactly the same trades in the same order on each. It is lenient for the
 * reason the page parameters are: a malformed or unknown value is ignored — every stock, every
 * action, newest first — instead of answering `400`, and the page response reports the filter it
 * actually applied, so the leniency is visible rather than silent. Nothing here can change state.
 *
 * A well-formed symbol the run never traded is **not** malformed: it filters to nothing, which is
 * the true answer, and the browser shows "No trades match".
 */
export function parseTradeLogQuery(query: {
  symbol?: unknown;
  action?: unknown;
  order?: unknown;
}): ParsedTradeLogQuery {
  const symbol = singleText(query.symbol);
  const action = singleText(query.action)?.toUpperCase();
  const order = singleText(query.order)?.toLowerCase();
  return {
    ...(symbol !== undefined && symbol.length <= MAX_TRADE_SYMBOL_LENGTH
      ? { symbol }
      : {}),
    ...(action !== undefined && isTradeLogAction(action) ? { action } : {}),
    order:
      order !== undefined && isTradeLogOrder(order)
        ? order
        : BACKTEST_TRADE_DEFAULT_ORDER,
  };
}

/** One non-blank string; a repeated parameter (`?symbol=A&symbol=B`) names no single value. */
function singleText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** What the backtest collection is narrowed to and how it is ordered. */
export type BacktestRunListQuery = {
  readonly q?: string;
  readonly status?: BacktestRunStatusFilter;
  readonly sort?: BacktestRunSort;
};

export type ParsedRunListRequest = BacktestRunListQuery & {
  /**
   * Whether the caller asked for a page (`page` or `pageSize` present, however malformed). Without
   * one, `GET /backtests` answers the whole matching list as it always has.
   */
  readonly paged: boolean;
  readonly page?: number;
  readonly pageSize?: number;
};

/**
 * `?page=`, `?pageSize=`, `?q=`, `?status=` and `?sort=` on `GET /backtests`.
 *
 * Lenient for the trade log's reasons: nothing here can change state, so a malformed or unknown
 * value is ignored — no search, every status, newest first, page 1 — rather than answered with
 * `400`, and the page response reports what was actually applied. A search longer than anything a
 * name could hold is ignored rather than truncated, so it never silently means something shorter.
 */
export function parseRunListRequest(query: {
  page?: unknown;
  pageSize?: unknown;
  q?: unknown;
  status?: unknown;
  sort?: unknown;
}): ParsedRunListRequest {
  const page = parsePositiveInteger(query.page);
  const pageSize = parsePositiveInteger(query.pageSize);
  const q = singleText(query.q);
  const status = singleText(query.status)?.toUpperCase();
  const sort = singleText(query.sort)?.toLowerCase();
  return {
    paged: query.page !== undefined || query.pageSize !== undefined,
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(q !== undefined && q.length <= BACKTEST_RUN_QUERY_MAX_LENGTH
      ? { q }
      : {}),
    ...(status !== undefined && isRunStatusFilter(status) ? { status } : {}),
    ...(sort !== undefined && isRunSort(sort) ? { sort } : {}),
  };
}

function isRunStatusFilter(value: string): value is BacktestRunStatusFilter {
  return (BACKTEST_RUN_STATUS_FILTERS as readonly string[]).includes(value);
}

function isRunSort(value: string): value is BacktestRunSort {
  return (BACKTEST_RUN_SORTS as readonly string[]).includes(value);
}

function isTradeLogAction(value: string): value is BacktestTradeAction {
  return (BACKTEST_TRADE_ACTIONS as readonly string[]).includes(value);
}

function isTradeLogOrder(value: string): value is BacktestTradeOrder {
  return (BACKTEST_TRADE_ORDERS as readonly string[]).includes(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * `PUT /backtests/{runId}/share`'s optional body: nothing at all, or `{ publishDescriptions }` with
 * a boolean. Anything else is refused rather than ignored, so a client can never believe it set a
 * publication choice the server did not record.
 */
export function parseShareRequest(body: unknown): UpdateBacktestShareRequest {
  if (body === undefined || body === null) {
    return {};
  }
  const record = asRecord(body);
  for (const key of Object.keys(record)) {
    if (key !== "publishDescriptions") {
      throw backtestInvalid(
        `Invalid request: \`${key}\` is not part of a share.`,
      );
    }
  }
  if (record.publishDescriptions === undefined) {
    return {};
  }
  if (typeof record.publishDescriptions !== "boolean") {
    throw backtestInvalid("`publishDescriptions` must be true or false.");
  }
  return { publishDescriptions: record.publishDescriptions };
}
