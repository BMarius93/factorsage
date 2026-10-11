import {
  DEFAULT_BENCHMARK_CODE,
  marketOverviewEtfs,
  type BenchmarkDailyPrice,
  type DateRange,
  type LocalDate,
  type MarketOverviewEtf,
} from "@intrinsic/domain";
import type { BenchmarkDataService } from "@intrinsic/stock-data";

/**
 * The report a market-overview bootstrap prints for each ETF (`docs/decisions/etf-market-data-v1.md`,
 * "Bootstrap").
 *
 * A bootstrap is judged by what is stored afterwards, not by what was asked for, so every figure
 * here is computed from the stored history read back through the provider-free reader. Nothing in
 * this file talks to the provider, PostgreSQL or Redis; it is the arithmetic, kept pure so it can be
 * tested on exact inputs.
 */

/** How many example dates a report lists for a gap. The count is always exact. */
const SAMPLE_SIZE = 5;

/**
 * Days past the end of its listing month a history may begin before it is flagged.
 *
 * A fund's first trading day is not always the first of the month, and a provider's first bar can
 * trail the listing by a few sessions; anything longer means the provider's history is shorter than
 * the fund's, which is worth an operator's attention but is not a failure.
 */
const LATE_START_TOLERANCE_DAYS = 45;

/** Calendar days between two consecutive bars beyond which the gap is reported. */
const LONG_GAP_DAYS = 10;

export type BootstrapGapReport = {
  count: number;
  sample: LocalDate[];
};

export type MarketOverviewBootstrapReport = {
  ticker: string;
  benchmarkCode: string;
  seriesId?: string;
  /** `FAILED` — the series could not be loaded; `WARN` — loaded, with something to look at. */
  status: "OK" | "WARN" | "FAILED";
  firstBar?: LocalDate;
  lastBar?: LocalDate;
  bars: number;
  /** The requested period before the first bar: the provider has no data there, by design. */
  preInception?: Required<DateRange>;
  /** Set when the first bar is long after the month the fund listed. */
  lateStart?: {
    listedIn: string;
    firstBar: LocalDate;
    daysAfterListingMonth: number;
  };
  /** Ranges durable coverage still does not hold: they were never asked for successfully. */
  missingCoverage: Required<DateRange>[];
  /** Reference-calendar sessions inside the series' own span with no bar. */
  calendarGaps: BootstrapGapReport;
  /** Bars on dates the reference calendar has no session for. */
  offCalendarBars: BootstrapGapReport;
  /** The longest run of calendar days between two consecutive bars. */
  longestGap?: { from: LocalDate; to: LocalDate; days: number };
  /** HTTP requests sent to the provider for this symbol, retries and pages included. */
  providerHttpRequests: number;
  residency?: "RESIDENT" | "REPUBLISHED" | "EMPTY" | "UNPUBLISHED";
  basisGeneration?: number;
  durationMs: number;
  warnings: string[];
  error?: string;
};

export type SummarizeBootstrapInput = {
  etf: MarketOverviewEtf;
  seriesId: string;
  requested: Required<DateRange>;
  rows: readonly Pick<BenchmarkDailyPrice, "date">[];
  missingCoverage: readonly Required<DateRange>[];
  /**
   * The execution calendar's sessions — SP500's stored dates — or undefined for SP500 itself,
   * which is the calendar and so cannot be checked against it.
   */
  referenceSessions?: readonly LocalDate[];
  providerHttpRequests: number;
  residency?: MarketOverviewBootstrapReport["residency"];
  basisGeneration?: number;
  durationMs: number;
};

export function summarizeBootstrapSeries(
  input: SummarizeBootstrapInput,
): MarketOverviewBootstrapReport {
  const dates = input.rows.map((row) => row.date);
  const firstBar = dates[0];
  const lastBar = dates.at(-1);
  const warnings: string[] = [];

  const report: MarketOverviewBootstrapReport = {
    ticker: input.etf.ticker,
    benchmarkCode: input.etf.benchmarkCode,
    seriesId: input.seriesId,
    status: "OK",
    ...(firstBar ? { firstBar } : {}),
    ...(lastBar ? { lastBar } : {}),
    bars: dates.length,
    missingCoverage: [...input.missingCoverage],
    calendarGaps: { count: 0, sample: [] },
    offCalendarBars: { count: 0, sample: [] },
    providerHttpRequests: input.providerHttpRequests,
    ...(input.residency ? { residency: input.residency } : {}),
    ...(input.basisGeneration !== undefined
      ? { basisGeneration: input.basisGeneration }
      : {}),
    durationMs: input.durationMs,
    warnings,
  };

  if (!firstBar || !lastBar) {
    warnings.push(
      "no bars are stored: the provider returned nothing in the requested range",
    );
    report.status = "FAILED";
    return report;
  }

  if (firstBar > input.requested.from) {
    report.preInception = {
      from: input.requested.from,
      to: previousDay(firstBar),
    };
  }

  const listingMonthEnd = endOfMonth(input.etf.listedIn);
  const daysAfterListingMonth = daysBetween(listingMonthEnd, firstBar);
  if (daysAfterListingMonth > LATE_START_TOLERANCE_DAYS) {
    report.lateStart = {
      listedIn: input.etf.listedIn,
      firstBar,
      daysAfterListingMonth,
    };
    warnings.push(
      `history begins ${firstBar}, ${daysAfterListingMonth} days after the ${input.etf.listedIn} listing month`,
    );
  }

  if (input.residency === "UNPUBLISHED") {
    warnings.push(
      "the Redis projection could not be published, so reads fall back to PostgreSQL; rerun to publish it",
    );
  }

  if (report.missingCoverage.length > 0) {
    warnings.push(
      `${report.missingCoverage.length} requested range(s) are not durably covered; rerun to resume`,
    );
  }

  if (input.referenceSessions) {
    const stored = new Set(dates);
    const reference = new Set(input.referenceSessions);
    report.calendarGaps = collect(
      input.referenceSessions.filter(
        (date) => date >= firstBar && date <= lastBar && !stored.has(date),
      ),
    );
    report.offCalendarBars = collect(
      dates.filter(
        (date) =>
          date >= (input.referenceSessions?.[0] ?? date) &&
          date <= (input.referenceSessions?.at(-1) ?? date) &&
          !reference.has(date),
      ),
    );
    if (report.calendarGaps.count > 0) {
      warnings.push(
        `${report.calendarGaps.count} execution-calendar session(s) inside the history have no bar`,
      );
    }
    if (report.offCalendarBars.count > 0) {
      warnings.push(
        `${report.offCalendarBars.count} bar(s) fall on dates the execution calendar has no session for`,
      );
    }
  }

  for (let index = 1; index < dates.length; index += 1) {
    const from = dates[index - 1] as LocalDate;
    const to = dates[index] as LocalDate;
    const days = daysBetween(from, to);
    if (!report.longestGap || days > report.longestGap.days) {
      report.longestGap = { from, to, days };
    }
  }
  if (report.longestGap && report.longestGap.days > LONG_GAP_DAYS) {
    warnings.push(
      `${report.longestGap.days} calendar days pass between ${report.longestGap.from} and ${report.longestGap.to}`,
    );
  }

  if (warnings.length > 0) {
    report.status = "WARN";
  }
  return report;
}

export function failedBootstrapSeries(input: {
  etf: MarketOverviewEtf;
  seriesId?: string;
  providerHttpRequests: number;
  durationMs: number;
  error: unknown;
}): MarketOverviewBootstrapReport {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  return {
    ticker: input.etf.ticker,
    benchmarkCode: input.etf.benchmarkCode,
    ...(input.seriesId ? { seriesId: input.seriesId } : {}),
    status: "FAILED",
    bars: 0,
    missingCoverage: [],
    calendarGaps: { count: 0, sample: [] },
    offCalendarBars: { count: 0, sample: [] },
    providerHttpRequests: input.providerHttpRequests,
    durationMs: input.durationMs,
    warnings: [],
    error: message,
  };
}

/** The slice of the canonical loader a bootstrap uses. */
export type MarketOverviewBootstrapService = Pick<
  BenchmarkDataService,
  | "getBenchmark"
  | "ensureBenchmarkHydrated"
  | "missingBenchmarkCoverage"
  | "ensureBenchmarkResident"
  | "readFullBenchmarkHistory"
>;

export type MarketOverviewBootstrapResult = {
  from: LocalDate;
  to: LocalDate;
  reports: MarketOverviewBootstrapReport[];
  providerHttpRequests: number;
  bars: number;
  failed: number;
  durationMs: number;
};

/**
 * Loads every market-overview ETF's full history through the canonical loader, then reports what
 * is stored (`docs/decisions/etf-market-data-v1.md`, "Bootstrap").
 *
 * - **One series at a time, `SP500` first.** The provider gate is shared with live traffic, and
 *   SP500's stored sessions are the execution calendar every other ETF is checked against.
 * - **The canonical path only.** `ensureBenchmarkHydrated` subtracts durable coverage, takes the
 *   hydration lock, pages the provider through the gate, writes PostgreSQL and publishes Redis. A
 *   rerun therefore asks only for what is still missing, and a range that was asked and came back
 *   empty — the years before a fund listed — is never asked again. Rows are keyed by
 *   `(seriesId, date)`, so nothing is ever stored twice.
 * - **Then residency is proved.** `ensureBenchmarkResident` compares the Redis head with every
 *   year's digest in PostgreSQL and republishes what differs, and the report is computed from the
 *   history read back through the provider-free reader.
 * - **Isolated.** A series that fails is reported and the others still load; the caller exits
 *   non-zero when any failed, and rerunning resumes.
 */
export async function bootstrapMarketOverview(input: {
  benchmarks: MarketOverviewBootstrapService;
  from: LocalDate;
  to: LocalDate;
  /** HTTP requests the provider has received for a symbol so far in this process. */
  providerRequestsFor(symbol: string): number;
  etfs?: readonly MarketOverviewEtf[];
  /** The code whose stored sessions are the reference calendar; SP500 unless a test names one. */
  calendarCode?: string;
  onSeries?: (report: MarketOverviewBootstrapReport) => void;
  clock?: () => number;
}): Promise<MarketOverviewBootstrapResult> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const calendarCode = input.calendarCode ?? DEFAULT_BENCHMARK_CODE;
  const etfs = calendarFirst(input.etfs ?? marketOverviewEtfs(), calendarCode);
  const requested = { from: input.from, to: input.to };
  const reports: MarketOverviewBootstrapReport[] = [];
  let referenceSessions: LocalDate[] | undefined;

  for (const etf of etfs) {
    const seriesStarted = clock();
    let seriesId: string | undefined;
    let symbol: string | undefined;
    let requestsBefore = 0;
    let report: MarketOverviewBootstrapReport;
    try {
      const benchmark = await input.benchmarks.getBenchmark(etf.benchmarkCode);
      const series = benchmark.series;
      seriesId = series.id;
      symbol = series.providerSymbol;
      requestsBefore = input.providerRequestsFor(symbol);

      await input.benchmarks.ensureBenchmarkHydrated(series, requested);
      const missingCoverage = await input.benchmarks.missingBenchmarkCoverage(
        series,
        requested,
      );
      const residency = await input.benchmarks.ensureBenchmarkResident(series);
      const history = await input.benchmarks.readFullBenchmarkHistory(
        series,
        input.to,
      );
      const isCalendar = etf.benchmarkCode === calendarCode;
      report = summarizeBootstrapSeries({
        etf,
        seriesId: series.id,
        requested,
        rows: history.rows,
        missingCoverage,
        ...(isCalendar || !referenceSessions ? {} : { referenceSessions }),
        providerHttpRequests:
          input.providerRequestsFor(symbol) - requestsBefore,
        residency: residency.status,
        basisGeneration: history.basisGeneration,
        durationMs: clock() - seriesStarted,
      });
      if (isCalendar && report.status !== "FAILED") {
        referenceSessions = history.rows.map((row) => row.date);
      }
      if (!isCalendar && !referenceSessions) {
        report.warnings.push(
          "not checked against the execution calendar: SP500 did not load",
        );
        report.status = report.status === "FAILED" ? "FAILED" : "WARN";
      }
    } catch (error) {
      report = failedBootstrapSeries({
        etf,
        ...(seriesId ? { seriesId } : {}),
        providerHttpRequests: symbol
          ? input.providerRequestsFor(symbol) - requestsBefore
          : 0,
        durationMs: clock() - seriesStarted,
        error,
      });
    }
    reports.push(report);
    input.onSeries?.(report);
  }

  return {
    from: input.from,
    to: input.to,
    reports,
    providerHttpRequests: reports.reduce(
      (sum, report) => sum + report.providerHttpRequests,
      0,
    ),
    bars: reports.reduce((sum, report) => sum + report.bars, 0),
    failed: reports.filter((report) => report.status === "FAILED").length,
    durationMs: clock() - started,
  };
}

/** The execution calendar loads first, so every other ETF can be checked against it. */
function calendarFirst(
  etfs: readonly MarketOverviewEtf[],
  calendarCode: string,
): readonly MarketOverviewEtf[] {
  const calendar = etfs.filter((etf) => etf.benchmarkCode === calendarCode);
  return [
    ...calendar,
    ...etfs.filter((etf) => etf.benchmarkCode !== calendarCode),
  ];
}

/** One line per ETF, for the terminal. The JSON report carries the detail. */
export function formatBootstrapLine(
  report: MarketOverviewBootstrapReport,
): string {
  const span =
    report.firstBar && report.lastBar
      ? `${report.firstBar} → ${report.lastBar}`
      : "no bars";
  const base = `${report.status.padEnd(6)} ${report.ticker.padEnd(5)} ${span}, ${report.bars} bars, ${report.providerHttpRequests} provider request(s), ${report.durationMs} ms`;
  if (report.error) {
    return `${base} — ${report.error}`;
  }
  return report.warnings.length > 0
    ? `${base} — ${report.warnings.join("; ")}`
    : base;
}

/**
 * Wraps `fetch` to count the HTTP requests sent per provider symbol.
 *
 * The count is what the provider actually received — every page of a walk and every retry — which
 * is the figure the bootstrap's request estimate is checked against. Only the `symbol` query
 * parameter is read from a URL; the URL itself, which carries the API key, is never stored or
 * logged.
 */
export function countingFetch(inner: typeof fetch): {
  fetch: typeof fetch;
  requestsFor(symbol: string): number;
  total(): number;
} {
  const counts = new Map<string, number>();
  let total = 0;
  const wrapped: typeof fetch = (input, init) => {
    total += 1;
    const symbol = symbolOf(input);
    if (symbol) {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    return inner(input, init);
  };
  return {
    fetch: wrapped,
    requestsFor: (symbol) => counts.get(symbol.toUpperCase()) ?? 0,
    total: () => total,
  };
}

function symbolOf(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return new URL(raw).searchParams.get("symbol")?.toUpperCase() ?? undefined;
  } catch {
    return undefined;
  }
}

function collect(dates: readonly LocalDate[]): BootstrapGapReport {
  return { count: dates.length, sample: dates.slice(0, SAMPLE_SIZE) };
}

function toEpochDay(date: LocalDate): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 86_400_000;
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(toEpochDay(to) - toEpochDay(from));
}

function previousDay(date: LocalDate): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The last day of a `YYYY-MM` month. */
function endOfMonth(month: string): LocalDate {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year as number, monthNumber as number, 0))
    .toISOString()
    .slice(0, 10);
}
