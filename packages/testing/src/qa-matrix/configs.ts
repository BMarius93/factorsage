import { DEFAULT_BENCHMARK_CODE } from "@intrinsic/contracts";
import type { QaMatrixPeriods } from "./clock.js";
import { QA_MATRIX_NAME_PREFIX } from "./strategies.js";

/**
 * The ten deterministic QA-MATRIX Backtest configuration fixtures.
 *
 * **These are versioned repository fixtures, not database rows, because the domain has no
 * persistent `BacktestConfiguration` entity.** A Strategy, a Stock List and a Backtest run are all
 * first-class records; the configuration is the set of execution inputs a `CreateBacktestRunRequest`
 * carries and a submitted run freezes into its immutable snapshot. Inventing a table for it purely
 * so QA could point at one would add a product entity the product does not have.
 *
 * Every period is derived from the matrix clock rather than written down. The product horizon moves
 * with the calendar — the loader clips every projection to `[today - 30y, today]` — so a literal
 * start date is a slow-acting bug: the day after it is written it asks for history the loader
 * silently drops, and the "thirty-year" run becomes a shorter one against a boundary nobody
 * re-checked. See `clock.ts`; one declared clock always yields the identical matrix.
 *
 * Benchmark and calendar semantics are held constant on purpose: every configuration compares
 * against the one V1 benchmark, so a difference between two matrix runs is never a difference in
 * what they were compared with.
 */

export type QaMatrixConfigFixture = {
  /** `C01` … `C10`; the last third of a `QA-MATRIX-Sxx-Lxx-Cxx` run identity. */
  readonly id: string;
  /** Documentation identity only — no configuration row exists to carry a name. */
  readonly name: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixConfigBehaviour[];
  /** Exactly the body a matrix runner POSTs to `/backtests`, minus the strategy and list ids. */
  readonly request: {
    readonly benchmarkCode: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly initialCapital: number;
    readonly monthlyContribution: number;
    readonly maximumPositions: number;
  };
};

export const QA_MATRIX_CONFIG_BEHAVIOURS = [
  "PERIOD_30Y",
  "PERIOD_10Y",
  "PERIOD_3Y",
  "PERIOD_1Y",
  "STARTS_AT_PRODUCT_HORIZON",
  "NO_CONTRIBUTION",
  "NORMAL_CONTRIBUTION",
  "LARGE_CONTRIBUTION",
  "SMALL_INITIAL_CAPITAL",
  "NORMAL_INITIAL_CAPITAL",
  "LARGE_INITIAL_CAPITAL",
  "SINGLE_POSITION",
  "FOCUSED_POSITIONS",
  "NORMAL_POSITIONS",
  "LARGER_POSITIONS",
] as const;

export type QaMatrixConfigBehaviour =
  (typeof QA_MATRIX_CONFIG_BEHAVIOURS)[number];

type ConfigFixtureSpec = {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly behaviours: readonly QaMatrixConfigBehaviour[];
  /** Which derived period this configuration runs over. */
  readonly period: keyof Pick<
    QaMatrixPeriods,
    "thirtyYear" | "tenYear" | "threeYear" | "oneYear"
  >;
  readonly initialCapital: number;
  readonly monthlyContribution: number;
  readonly maximumPositions: number;
};

const CONFIG_SPECS: readonly ConfigFixtureSpec[] = [
  {
    id: "C01",
    slug: "thirty-year-baseline",
    description:
      "The full thirty-year product horizon, starting **exactly** on the oldest date the product " +
      "permits for this clock, with no contributions and a normal ten-position portfolio. The " +
      "reference configuration, and the one that proves the boundary itself is executable rather " +
      "than quietly clipped.",
    behaviours: [
      "PERIOD_30Y",
      "STARTS_AT_PRODUCT_HORIZON",
      "NO_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "thirtyYear",
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 10,
  },
  {
    id: "C02",
    slug: "ten-year-baseline",
    description:
      "The same portfolio over ten years. Paired with C01 it isolates the effect of the period " +
      "alone, and it is the period the later-listing lists are fully populated across.",
    behaviours: [
      "PERIOD_10Y",
      "NO_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "tenYear",
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 10,
  },
  {
    id: "C03",
    slug: "three-year-baseline",
    description:
      "Three years. Short enough that a sparse strategy may legitimately never trade, and long " +
      "enough that a weekly moving average has warmed up well before the period starts.",
    behaviours: [
      "PERIOD_3Y",
      "NO_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "threeYear",
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 10,
  },
  {
    id: "C04",
    slug: "one-year-baseline",
    description:
      "One year — the shortest period in the matrix, and the one that finishes in a single annual " +
      "execution window rather than thirty of them.",
    behaviours: [
      "PERIOD_1Y",
      "NO_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "oneYear",
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 10,
  },
  {
    id: "C05",
    slug: "normal-contribution",
    description:
      "Ten years with a modest recurring deposit against a modest starting balance. The ordinary " +
      "dollar-cost-averaging shape: every month's first simulated trading day deposits cash and " +
      "re-measures already-fired BUY levels against a slightly larger portfolio.",
    behaviours: [
      "PERIOD_10Y",
      "NORMAL_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "tenYear",
    initialCapital: 10_000,
    monthlyContribution: 500,
    maximumPositions: 10,
  },
  {
    id: "C06",
    slug: "large-contribution-focused",
    description:
      "Ten years where the contributions dwarf the opening balance — 1,000 to start and 25,000 " +
      "every month — into a focused five-position portfolio. Almost all invested capital arrives " +
      "on deposit dates, so the contribution top-up path decides the result, and a full position " +
      "being a fifth of the portfolio makes each top-up large enough to see.",
    behaviours: [
      "PERIOD_10Y",
      "LARGE_CONTRIBUTION",
      "SMALL_INITIAL_CAPITAL",
      "FOCUSED_POSITIONS",
    ],
    period: "tenYear",
    initialCapital: 1_000,
    monthlyContribution: 25_000,
    maximumPositions: 5,
  },
  {
    id: "C07",
    slug: "minimum-capital",
    description:
      "Ten years starting from the contract's minimum initial capital of 1 and never adding to " +
      "it. With ten position slots a full position is a tenth of one unit of currency, and a 25% " +
      "BUY level targets a fortieth — the case that proves share quantities stay continuous " +
      "instead of rounding to zero.",
    behaviours: [
      "PERIOD_10Y",
      "NO_CONTRIBUTION",
      "SMALL_INITIAL_CAPITAL",
      "NORMAL_POSITIONS",
    ],
    period: "tenYear",
    initialCapital: 1,
    monthlyContribution: 0,
    maximumPositions: 10,
  },
  {
    id: "C08",
    slug: "maximum-capital",
    description:
      "Thirty years at the contract's maximum initial capital of one billion, across twenty " +
      "position slots. Cash is never the binding constraint, so what limits the portfolio is the " +
      "strategy's own signals and the number of slots — the opposite pressure to C07.",
    behaviours: [
      "PERIOD_30Y",
      "STARTS_AT_PRODUCT_HORIZON",
      "NO_CONTRIBUTION",
      "LARGE_INITIAL_CAPITAL",
      "LARGER_POSITIONS",
    ],
    period: "thirtyYear",
    initialCapital: 1_000_000_000,
    monthlyContribution: 0,
    maximumPositions: 20,
  },
  {
    id: "C09",
    slug: "single-position",
    description:
      "Ten years with exactly one position slot, so a full position is the entire portfolio and " +
      "any second candidate is skipped without being marked fired. It is the configuration where " +
      "candidate ordering is decisive and where an exit frees the only slot for a different " +
      "symbol at the same close.",
    behaviours: [
      "PERIOD_10Y",
      "NO_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "SINGLE_POSITION",
    ],
    period: "tenYear",
    initialCapital: 100_000,
    monthlyContribution: 0,
    maximumPositions: 1,
  },
  {
    id: "C10",
    slug: "wide-portfolio-contribution",
    description:
      "Thirty years, thirty position slots and a recurring deposit. A full position is a " +
      "thirtieth of the portfolio, so the whole of the large list can be held at once and the " +
      "run combines the longest period, the widest portfolio and monthly contributions.",
    behaviours: [
      "PERIOD_30Y",
      "STARTS_AT_PRODUCT_HORIZON",
      "NORMAL_CONTRIBUTION",
      "NORMAL_INITIAL_CAPITAL",
      "LARGER_POSITIONS",
    ],
    period: "thirtyYear",
    initialCapital: 250_000,
    monthlyContribution: 1_000,
    maximumPositions: 30,
  },
];

/** The ten configurations for one matrix clock. */
export function qaMatrixConfigs(
  periods: QaMatrixPeriods,
): readonly QaMatrixConfigFixture[] {
  return CONFIG_SPECS.map((spec) => {
    const window = periods[spec.period];
    return {
      id: spec.id,
      name: `${QA_MATRIX_NAME_PREFIX}${spec.id}-${spec.slug}`,
      description: spec.description,
      behaviours: spec.behaviours,
      request: {
        benchmarkCode: DEFAULT_BENCHMARK_CODE,
        startDate: window.startDate,
        endDate: window.endDate,
        initialCapital: spec.initialCapital,
        monthlyContribution: spec.monthlyContribution,
        maximumPositions: spec.maximumPositions,
      },
    };
  });
}

/** The period each configuration id runs over; used by the boundary-list documentation and tests. */
export function qaMatrixConfigPeriod(
  id: string,
): ConfigFixtureSpec["period"] | undefined {
  return CONFIG_SPECS.find((spec) => spec.id === id)?.period;
}
