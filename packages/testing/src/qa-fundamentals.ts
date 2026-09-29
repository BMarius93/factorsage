/**
 * The Fundamental Metric history of the fictional QA security `QATEST1`, defined once.
 *
 * The QA seed writes these readings onto the security's persisted daily derived state, and the
 * Stock Details browser suites derive every expectation from the same table — so what a spec
 * asserts and what the page reads from the database cannot drift apart. Like the seed's intrinsic
 * values, the readings are fixture constants rather than the result of materializing invented
 * filings: the point-in-time materialization is proven against real statements by the stock-data
 * and API suites, and the browser needs known persisted values, not a second calculation.
 *
 * Deliberately free of workspace imports, exactly like `./personas` and `./e2e-stack`: the
 * Playwright harness imports it through a dependency-free subpath without pulling the domain or
 * database layers into the web app. Identities are therefore plain strings here; the seed's own
 * test pins them to the product catalog.
 *
 * The seed's history is 160 complete Monday-Friday weeks with no holidays, so a session's week is
 * its index divided by five. Each metric is a list of stretches: from `fromWeek` onward the stored
 * reading is `value`, until the next stretch; `null` is unavailable, and every session before the
 * first stretch is unavailable too.
 */

export type QaFundamentalStretch = {
  readonly fromWeek: number;
  readonly value: number | null;
};

/** Weeks of seeded history; the last complete week before the seed ran is week 159. */
export const QA_FUNDAMENTAL_HISTORY_WEEKS = 160;

/**
 * Every Fundamental Metric's stretches.
 *
 * - `ROIC_TTM` steps 12.5% -> 18.25% inside the default one-year window, is unavailable for five
 *   weeks, and is restored at 21% — a different value, so nothing can be carried through the gap.
 * - `DEBT_TO_EQUITY` is 0.75x (which must never read `0.8x`) and then exactly 1 (`1.0x`).
 * - `NET_DEBT_TO_EBITDA_TTM` is a negative multiple, -0.4x: net cash.
 * - `REVENUE_GROWTH_TTM_YOY` goes 8.5% -> a real 0% -> -3.25%.
 * - `EPS_GROWTH_TTM_YOY` is unavailable on every session: a whole history with nothing to draw.
 * - The rest hold one distinctive reading each, so reading the wrong metric cannot pass.
 */
export const QA_FUNDAMENTAL_STRETCHES = {
  REVENUE_GROWTH_TTM_YOY: [
    { fromWeek: 60, value: 8.5 },
    { fromWeek: 125, value: 0 },
    { fromWeek: 145, value: -3.25 },
  ],
  EPS_GROWTH_TTM_YOY: [],
  FCF_GROWTH_TTM_YOY: [{ fromWeek: 40, value: 4.4 }],
  GROSS_MARGIN_TTM: [{ fromWeek: 40, value: 44.44 }],
  OPERATING_MARGIN_TTM: [{ fromWeek: 40, value: 22.2 }],
  NET_MARGIN_TTM: [{ fromWeek: 40, value: 11.1 }],
  FCF_MARGIN_TTM: [{ fromWeek: 40, value: 9.9 }],
  ROIC_TTM: [
    { fromWeek: 40, value: 12.5 },
    { fromWeek: 120, value: 18.25 },
    { fromWeek: 135, value: null },
    { fromWeek: 140, value: 21 },
  ],
  ROE_TTM: [{ fromWeek: 40, value: 16.6 }],
  ROA_TTM: [{ fromWeek: 40, value: 7.7 }],
  DEBT_TO_EQUITY: [
    { fromWeek: 40, value: 0.75 },
    { fromWeek: 130, value: 1 },
  ],
  CURRENT_RATIO: [{ fromWeek: 40, value: 1.6 }],
  NET_DEBT_TO_EBITDA_TTM: [{ fromWeek: 40, value: -0.4 }],
  INTEREST_COVERAGE_TTM: [{ fromWeek: 40, value: 8.25 }],
  ASSET_TURNOVER_TTM: [{ fromWeek: 40, value: 0.9 }],
} as const satisfies Readonly<Record<string, readonly QaFundamentalStretch[]>>;

export type QaFundamentalMetricId = keyof typeof QA_FUNDAMENTAL_STRETCHES;

/** The stored reading of one metric in one seeded week, or `undefined` where it is unavailable. */
export function qaFundamentalValue(
  metricId: QaFundamentalMetricId,
  week: number,
): number | undefined {
  let value: number | null = null;
  for (const stretch of QA_FUNDAMENTAL_STRETCHES[
    metricId
  ] as readonly QaFundamentalStretch[]) {
    if (stretch.fromWeek > week) {
      break;
    }
    value = stretch.value;
  }
  return value ?? undefined;
}
