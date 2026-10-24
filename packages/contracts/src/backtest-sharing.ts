import type {
  BacktestAnnualReturnResponse,
  BacktestCurvePointResponse,
  BacktestResultSummaryResponse,
} from "./backtests.js";
import type { StrategyDefinition, StrategySignal } from "./strategies.js";

/**
 * Public backtest sharing (`docs/decisions/backtest-sharing-v1.md`).
 *
 * An owner may publish one completed run's **results** behind an unguessable link. What crosses
 * that link is the allowlisted report below and nothing else: it is a contract of its own, never a
 * filtered copy of `BacktestRunDetailResponse`, so a field added to the private detail can never
 * reach a public reader by accident. The strategy, the stock list, its securities, the trades and
 * the owner stay private — the report says only how many rules and securities there were.
 */

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

/** Random bytes behind one share token: 256 bits, so a token can be neither guessed nor walked. */
export const BACKTEST_SHARE_TOKEN_BYTES = 32;

/** 32 bytes in unpadded base64url are exactly 43 characters of `[A-Za-z0-9_-]`. */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a string can be a share token at all.
 *
 * Checked before any lookup so a malformed path segment is answered `404` without touching the
 * database, and so nothing but a well-formed token is ever interpolated into a URL.
 */
export function isBacktestShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

/** The public page's path on the web origin. */
export function backtestSharePath(token: string): string {
  return `/share/${token}`;
}

/** The link-preview image's path on the web origin: a stable URL, never data in the link. */
export function backtestSharePreviewImagePath(token: string): string {
  return `${backtestSharePath(token)}/preview.png`;
}

/**
 * `GET`, `PUT` and `DELETE /backtests/{runId}/share` — the owner's view of the run's link.
 *
 * `url` is the absolute public address, built by the API from the deployment's web origin exactly
 * as emailed links are, so the owner copies the one address everyone else will open.
 */
export type BacktestShareResponse = {
  shared: boolean;
  url: string | null;
  /** When the current link was created; null while the run is not shared. */
  sharedAt: string | null;
};

// ---------------------------------------------------------------------------
// The public report
// ---------------------------------------------------------------------------

/**
 * The benchmark as a public reader sees it: the catalog code and the product name. Never its
 * database id, its series or its provider symbol (`AGENTS.md` invariant 13).
 */
export type SharedBacktestBenchmarkResponse = {
  code: string;
  name: string;
};

/**
 * The general simulation parameters the run froze, read from its immutable snapshot.
 *
 * Deliberately absent: the strategy's name, id, version and definition; the stock list's name, id
 * and members; the methodology record; anything about the owner. The two counts are the only
 * trace of the strategy and the list, and both come from the snapshot, never from the current
 * Strategy or Stock List rows.
 */
export type SharedBacktestConfigurationResponse = {
  startDate: string;
  endDate: string;
  initialCapital: number;
  monthlyContribution: number;
  maximumPositions: number;
  /** Derived, never entered: `100 / maximumPositions`. */
  fullPositionPercent: number;
  benchmark: SharedBacktestBenchmarkResponse;
  /** How many securities the run's frozen list resolved to — the private page's "Stocks". */
  securityCount: number;
  /** {@link strategyRuleCount} of the run's frozen definition. */
  strategyRuleCount: number;
};

/**
 * The aggregate figures a public report carries, by name.
 *
 * An allowlist rather than the whole summary: each entry is a run-level aggregate that names no
 * security, no date of any trade and no position. `totalTrades` is the KPI row's "Trades" count —
 * how active the strategy was, not what it traded. Adding a field here publishes it to every
 * shared link, which is why the API's contract test pins this exact list.
 */
export const SHARED_BACKTEST_SUMMARY_FIELDS = [
  "firstSimulatedDate",
  "lastSimulatedDate",
  "finalValue",
  "netProfit",
  "portfolioReturnPercent",
  "benchmarkReturnPercent",
  "alphaPercent",
  "portfolioCagrPercent",
  "benchmarkCagrPercent",
  "maxDrawdownPercent",
  "benchmarkMaxDrawdownPercent",
  "totalTrades",
] as const satisfies readonly (keyof BacktestResultSummaryResponse)[];

export type SharedBacktestSummaryField =
  (typeof SHARED_BACKTEST_SUMMARY_FIELDS)[number];

/** The same numbers the owner's page shows, computed by the same code — never re-derived. */
export type SharedBacktestSummaryResponse = Pick<
  BacktestResultSummaryResponse,
  SharedBacktestSummaryField
>;

export type SharedBacktestResultResponse = {
  summary: SharedBacktestSummaryResponse;
  /**
   * Per calendar year, never cumulative — the Strategy's figure and the benchmark's over the same
   * window, exactly the owner page's own chaining.
   */
  annualReturns: BacktestAnnualReturnResponse[];
  /**
   * The owner's page's chart curve, point for point: the same downsampled projection of the
   * persisted daily equity, so the two charts agree on every date and value.
   */
  curve: BacktestCurvePointResponse[];
};

/** `GET /shared-backtests/{token}`. */
export type SharedBacktestReportResponse = {
  /**
   * The run's user-facing Run ID — the number its owner's page shows as `Run #0084`, rendered by
   * `backtestRunLabel` — so a shared report can be quoted back precisely. Never the run's UUID:
   * the database identity does not cross the public link, which is the token alone.
   */
  runNumber: number;
  /** The absolute public address of this report. */
  url: string;
  completedAt: string;
  configuration: SharedBacktestConfigurationResponse;
  result: SharedBacktestResultResponse;
};

// ---------------------------------------------------------------------------
// The link-preview card
// ---------------------------------------------------------------------------

/** At most this many points reach the link-preview image. Rendering only; never a calculation. */
export const SHARED_BACKTEST_PREVIEW_MAX_POINTS = 600;

/** One day of the two absolute scenarios the preview draws, exactly as stored. */
export type SharedBacktestPreviewPoint = {
  date: string;
  strategyValue: number;
  /** Null on a date the funded benchmark has no value, and for runs that never recorded one. */
  benchmarkValue: number | null;
};

/**
 * `GET /shared-backtests/{token}/preview` — what the 1200 × 630 link-preview card is drawn from.
 *
 * The figures are the stored summary's, never recomputed from the sampled series; the series is
 * the persisted daily equity thinned by {@link sampleSharedBacktestPreview} for drawing alone.
 */
export type SharedBacktestPreviewResponse = {
  configuration: Pick<
    SharedBacktestConfigurationResponse,
    | "startDate"
    | "endDate"
    | "benchmark"
    | "securityCount"
    | "strategyRuleCount"
  >;
  headline: Pick<
    SharedBacktestSummaryResponse,
    | "portfolioCagrPercent"
    | "benchmarkCagrPercent"
    | "portfolioReturnPercent"
    | "benchmarkReturnPercent"
    | "maxDrawdownPercent"
  >;
  series: SharedBacktestPreviewPoint[];
};

// ---------------------------------------------------------------------------
// Demonstrations
// ---------------------------------------------------------------------------

/** The most demonstrations `GET /demo-backtests` lists: a curated shelf, never a directory. */
export const DEMO_BACKTESTS_MAX = 12;

/**
 * One operator-featured demonstration (`docs/decisions/entitlements-v2.md` §4): a shared report
 * listed publicly, so a Guest can see what a backtest produces without running one. Everything it
 * carries is what the shared report itself publishes — the headline figures and the general
 * parameters — and reading it executes nothing.
 */
export type DemoBacktestResponse = {
  title: string;
  description: string | null;
  /** The shared report on the web origin, `/share/{token}`. */
  path: string;
  /** The same, absolute. */
  url: string;
  completedAt: string;
  configuration: SharedBacktestPreviewResponse["configuration"];
  headline: SharedBacktestPreviewResponse["headline"];
};

export type DemoBacktestListResponse = {
  demos: DemoBacktestResponse[];
};

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

function signalRules(signal: StrategySignal): number {
  return signal.conditions.length + (signal.trigger === undefined ? 0 : 1);
}

/**
 * How many rules a strategy definition holds: every Condition and every Trigger, across all BUY
 * levels, all SELL levels and every FINAL EXIT Exit Rule.
 *
 * A rule is one line a user writes in the Strategy Builder — `Price is below EMA 200D` — which is
 * how the product already speaks of them. Levels and Exit Rules are the containers those lines
 * sit in, so they are not counted themselves. Pass the **canonical** definition (the frozen
 * snapshot projected through `withCanonicalStrategyDefinition`), so a run frozen under schema
 * version 1 counts exactly as its upcast does.
 */
export function strategyRuleCount(definition: StrategyDefinition): number {
  let count = 0;
  for (const level of definition.buyLevels) {
    count += signalRules(level.signal);
  }
  for (const level of definition.sellLevels) {
    count += signalRules(level.signal);
  }
  for (const rule of definition.finalExit?.rules ?? []) {
    count += signalRules(rule.signal);
  }
  return count;
}

/**
 * Thins a run's daily series to at most `maxPoints` for the link-preview chart, deterministically,
 * keeping every extreme a reader would notice.
 *
 * Even striding — what the result curve uses — can step over the trough of a sharp drawdown and
 * draw a crash as a wobble. Here the first and last days are always kept, and the days between
 * them are cut into equal buckets in which the highest and lowest value of **each** line survive,
 * so every significant peak and trough of the Strategy and of the benchmark is still drawn, in
 * date order. The same input always yields the same output.
 *
 * Strictly for drawing: no figure is ever computed from the result.
 */
export function sampleSharedBacktestPreview<
  T extends { strategyValue: number; benchmarkValue: number | null },
>(
  points: readonly T[],
  maxPoints: number = SHARED_BACKTEST_PREVIEW_MAX_POINTS,
): T[] {
  // Two endpoints plus at least one bucket's four extremes.
  const limit = Math.max(6, Math.floor(maxPoints));
  if (points.length <= limit) {
    return [...points];
  }
  const lastIndex = points.length - 1;
  const interior = lastIndex - 1;
  // Each bucket contributes at most four indices: both lines' minimum and maximum.
  const bucketCount = Math.floor((limit - 2) / 4);
  const kept = new Set<number>([0, lastIndex]);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interior) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * interior) / bucketCount);
    let strategyMin = -1;
    let strategyMax = -1;
    let benchmarkMin = -1;
    let benchmarkMax = -1;
    for (let index = start; index < end; index += 1) {
      const point = points[index] as T;
      if (
        strategyMin < 0 ||
        point.strategyValue < (points[strategyMin] as T).strategyValue
      ) {
        strategyMin = index;
      }
      if (
        strategyMax < 0 ||
        point.strategyValue > (points[strategyMax] as T).strategyValue
      ) {
        strategyMax = index;
      }
      const benchmark = point.benchmarkValue;
      if (benchmark !== null) {
        if (
          benchmarkMin < 0 ||
          benchmark < ((points[benchmarkMin] as T).benchmarkValue as number)
        ) {
          benchmarkMin = index;
        }
        if (
          benchmarkMax < 0 ||
          benchmark > ((points[benchmarkMax] as T).benchmarkValue as number)
        ) {
          benchmarkMax = index;
        }
      }
    }
    for (const index of [
      strategyMin,
      strategyMax,
      benchmarkMin,
      benchmarkMax,
    ]) {
      if (index >= 0) {
        kept.add(index);
      }
    }
  }
  return [...kept]
    .sort((left, right) => left - right)
    .map((index) => points[index] as T);
}
