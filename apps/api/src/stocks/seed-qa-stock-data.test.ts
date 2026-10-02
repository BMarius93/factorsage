import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS as PRODUCT_FUNDAMENTAL_METRIC_IDS,
  VALUATION_RATIO_IDS,
} from "@intrinsic/contracts";
import {
  DAILY_OSCILLATORS,
  FUNDAMENTAL_METRIC_IDS,
  FUNDAMENTAL_METRICS,
  INTRINSIC_VALUE_BLENDS,
  MATERIALIZED_MOVING_AVERAGES,
  WEEKLY_MOVING_AVERAGES,
} from "@intrinsic/domain";
import {
  QA_FUNDAMENTAL_HISTORY_WEEKS,
  QA_FUNDAMENTAL_STRETCHES,
  QA_VALUATION_AVAILABILITY,
  QA_VALUATION_EARLY_SYNC_WEEK,
  QA_VALUATION_HISTORY_WEEKS,
  QA_VALUATION_NET_CASH,
  QA_VALUATION_QUARTERS,
  QA_VALUATION_REBASE,
  QA_VALUATION_VERIFIED_WEEK,
  QA_VALUATION_WITHHELD,
  qaValuationAvailable,
  qaValuationPublicWeek,
  qaValuationWeekMonday,
  type QaValuationRatioId,
} from "@intrinsic/testing";
import {
  addDays,
  aggregateCompletedWeeks,
  buildDailyDerivedState,
  buildValuationTimeline,
  calculateWilderRsi,
  valuationRatioColumns,
} from "@intrinsic/stock-data";
import type { FinancialStatement } from "@intrinsic/domain";
import { priceRetentionYears, subtractYears } from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  qaFundamentalFields,
  qaIntrinsicFixture,
  qaIntrinsicWindows,
  qaTradingDays,
  qaValuationDrafts,
  seedHistoryStart,
} from "./seed-qa-stock-data";

const SECURITY_ID = "qa-security";
const TODAY = "2026-08-28";
const SOURCE_AS_OF = "2026-01-05T20:00:00.000Z";

/**
 * The deterministic QA seed underpins the Playwright indicators journey, which asserts that
 * `SMA 200W` is unavailable while `SMA 100W` is available, and that `Balanced` and `Conservative`
 * are selectable while `Dividend` is not. Those expectations are properties of this seed, so they
 * are proven here rather than only in a browser run that CI does not perform.
 */
describe("QA stock-data seed", () => {
  const prices = qaTradingDays(SECURITY_ID, TODAY);
  const weeklyBars = aggregateCompletedWeeks(prices, TODAY, {
    historyStart: seedHistoryStart(TODAY),
    historyStartOrigin: "HORIZON",
  });
  const rows = buildDailyDerivedState({ prices, weeklyBars });
  const lastRow = rows.at(-1)!;

  it("leaves a genuinely unavailable interval between two calculable stretches", () => {
    // The browser suite needs an *interior* unavailable window to assert that the chart breaks the
    // line rather than drawing a straight segment across it. A leading warm-up cannot show that:
    // nothing is drawn before a series' first value either way. Proven here so the property is not
    // only a browser run's assumption.
    const windows = qaIntrinsicWindows(prices);
    expect(windows.valuationStart < windows.unavailableFrom).toBe(true);
    expect(windows.unavailableFrom < windows.unavailableUntil).toBe(true);
    expect(windows.unavailableUntil < prices.at(-1)!.date).toBe(true);

    const calculable = prices.filter(
      (price) => !windows.notCalculable(price.date),
    );
    // Calculable on both sides of the hole, and absent strictly inside it.
    expect(windows.notCalculable(windows.valuationStart)).toBe(false);
    expect(windows.notCalculable(windows.unavailableFrom)).toBe(true);
    expect(windows.notCalculable(windows.unavailableUntil)).toBe(false);
    expect(calculable.length).toBeGreaterThan(0);
    expect(calculable.length).toBeLessThan(prices.length);
  });

  it("produces a deterministic Monday-Friday history that reruns identically", () => {
    expect(qaTradingDays(SECURITY_ID, TODAY)).toEqual(prices);
    expect(prices.length % 5).toBe(0);
    // Every generated day is a weekday, so no bar is invented on a weekend.
    for (const price of prices) {
      const weekday = new Date(`${price.date}T00:00:00.000Z`).getUTCDay();
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
    expect(prices[0]?.date).toBe(seedHistoryStart(TODAY));
  });

  it("seeds a fixture whose provider boundary is its own first row", () => {
    // `QATEST1` exists only in this fixture, so the fixture is the authority on what came before
    // its first bar: nothing. That is why its coverage may claim the whole horizon — the claim is
    // true — and it is what lets Stock Details report a `PROVIDER` boundary rather than a
    // `HORIZON` one it has not established.
    //
    // The benchmark seed is the opposite case and claims only what it generated: `SP500` is backed
    // by a real symbol whose history genuinely continues further back.
    const first = prices[0]?.date as string;
    expect(first).toBe(seedHistoryStart(TODAY));
    expect(subtractYears(TODAY, 30) < first).toBe(true);
    // The claim the seed actually records reaches the **price-retention** horizon, not the
    // product one. A Stock Details window opened at the 30-year bound makes the loader widen its
    // load target to the retention boundary behind it; a fixture that only covered the product
    // horizon would leave that prefix permanently uncovered and send the loader to a provider
    // that has never heard of `QATEST1`, which is a browser-suite failure with no product cause.
    expect(subtractYears(TODAY, priceRetentionYears(30)) < first).toBe(true);
    expect(priceRetentionYears(30)).toBeGreaterThan(30);
  });

  it("seeds enough history for the shorter weekly periods and not the longest", () => {
    // This is exactly what the Playwright journey asserts through the picker.
    const warmed = WEEKLY_MOVING_AVERAGES.filter(
      (average) => lastRow[average.field] !== undefined,
    ).map((average) => average.field);
    const unwarmed = WEEKLY_MOVING_AVERAGES.filter(
      (average) => lastRow[average.field] === undefined,
    ).map((average) => average.field);

    expect(warmed).toContain("sma100w");
    expect(unwarmed).toContain("sma200w");
    expect(unwarmed).toContain("ema200w");
    // Unavailable means absent, never zero.
    for (const field of unwarmed) {
      expect(lastRow).not.toHaveProperty(field);
    }
    expect(weeklyBars.length).toBeGreaterThanOrEqual(100);
    expect(weeklyBars.length).toBeLessThan(200);
  });

  it("materializes every daily moving average on the final seeded trading day", () => {
    for (const average of MATERIALIZED_MOVING_AVERAGES.filter(
      (candidate) => candidate.timeframe === "1D",
    )) {
      expect(lastRow[average.field]).toBeTypeOf("number");
    }
  });

  it("materializes every RSI period through the production calculator", () => {
    // The Playwright oscillator journey selects all three RSI periods on the seeded stock, so all
    // three must be evaluable — and equal to what the production Wilder calculator produces over
    // the seeded closes, because the seed calls buildDailyDerivedState rather than a copy.
    expect(DAILY_OSCILLATORS.length).toBeGreaterThan(0);
    const closes = prices.map((price) => price.close);
    for (const oscillator of DAILY_OSCILLATORS) {
      const expected = calculateWilderRsi(closes, oscillator.period);
      expect(lastRow[oscillator.field]).toBe(expected.at(-1));
      expect(lastRow[oscillator.field]).toBeTypeOf("number");
      // Warm-up boundary: absent one day before the first evaluable close, present on it.
      expect(rows[oscillator.period - 1]).not.toHaveProperty(oscillator.field);
      expect(rows[oscillator.period]?.[oscillator.field]).toBe(
        expected[oscillator.period],
      );
    }
  });

  it("derives blend values from the canonical definitions rather than restating weights", () => {
    const fixture = qaIntrinsicFixture(SOURCE_AS_OF);

    for (const [blendId, value] of Object.entries(fixture.blends)) {
      const definition =
        INTRINSIC_VALUE_BLENDS[blendId as keyof typeof INTRINSIC_VALUE_BLENDS];
      const expected = definition.components.reduce(
        (sum, component) =>
          sum +
          (fixture.values[component.model] ?? Number.NaN) * component.weight,
        0,
      );
      expect(value).toBeCloseTo(expected, 10);
    }
  });

  it("leaves DDM and the blend that requires it unavailable", () => {
    const fixture = qaIntrinsicFixture(SOURCE_AS_OF);

    // The fictional company pays no dividend, so DDM is not applicable and DIVIDEND — the only
    // blend requiring it — must be absent rather than renormalized over the remaining components.
    expect(fixture.values.DDM).toBeUndefined();
    expect(fixture.blends.DIVIDEND).toBeUndefined();
    expect(fixture.blends.BALANCED).toBeTypeOf("number");
    expect(fixture.blends.CONSERVATIVE).toBeTypeOf("number");
    expect(
      INTRINSIC_VALUE_BLENDS.DIVIDEND.components.some(
        (component) => component.model === "DDM",
      ),
    ).toBe(true);
  });

  it("keeps every seeded valuation in one currency", () => {
    expect(qaIntrinsicFixture(SOURCE_AS_OF).currency).toBe("USD");
  });

  describe("Fundamental Metrics", () => {
    /** The stored row of the first session of a seeded week. */
    const weekRow = (week: number) =>
      ({ ...rows[week * 5], ...qaFundamentalFields(week * 5) }) as Record<
        string,
        unknown
      >;

    it("covers exactly the fifteen catalog metrics, in catalog order", () => {
      expect(Object.keys(QA_FUNDAMENTAL_STRETCHES)).toEqual([
        ...FUNDAMENTAL_METRIC_IDS,
      ]);
      expect(Object.keys(QA_FUNDAMENTAL_STRETCHES)).toEqual([
        ...PRODUCT_FUNDAMENTAL_METRIC_IDS,
      ]);
      expect(QA_FUNDAMENTAL_HISTORY_WEEKS * 5).toBe(prices.length);
    });

    it("stores the browser suites' readings in each metric's own column, and nothing where unavailable", () => {
      // Written out by hand for the stretches the browser suites assert against.
      expect(weekRow(39)).not.toHaveProperty("roicTtm");
      expect(weekRow(40).roicTtm).toBe(12.5);
      expect(weekRow(119).roicTtm).toBe(12.5);
      expect(weekRow(120).roicTtm).toBe(18.25);
      expect(weekRow(134).roicTtm).toBe(18.25);
      // A gap is absence, not zero and not the 18.25 before it.
      expect(weekRow(135)).not.toHaveProperty("roicTtm");
      expect(weekRow(139)).not.toHaveProperty("roicTtm");
      expect(weekRow(140).roicTtm).toBe(21);
      expect(weekRow(129).debtToEquity).toBe(0.75);
      expect(weekRow(130).debtToEquity).toBe(1);
      expect(weekRow(159).netDebtToEbitdaTtm).toBe(-0.4);
      expect(weekRow(125).revenueGrowthTtmYoy).toBe(0);
      expect(weekRow(159).revenueGrowthTtmYoy).toBe(-3.25);
      for (let week = 0; week < QA_FUNDAMENTAL_HISTORY_WEEKS; week += 1) {
        expect(weekRow(week)).not.toHaveProperty("epsGrowthTtmYoy");
      }
    });

    it("keeps the default one-year window's transitions inside it", () => {
      // The browser suite opens on about a year and asserts ROIC's step, gap and restoration
      // without loading older history.
      const lastYearWeeks = QA_FUNDAMENTAL_HISTORY_WEEKS - 52;
      for (const stretch of QA_FUNDAMENTAL_STRETCHES.ROIC_TTM.slice(1)) {
        expect(stretch.fromWeek).toBeGreaterThan(lastYearWeeks);
      }
    });

    it("writes percentages as percentage points, and only into registered columns", () => {
      // A fixture percentage written as a fraction (0.1825 for 18.25%) would still draw; this is
      // what keeps the fixture honest about percentage points.
      for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
        const values = (
          QA_FUNDAMENTAL_STRETCHES[
            entry.id as keyof typeof QA_FUNDAMENTAL_STRETCHES
          ] as readonly { value: number | null }[]
        ).flatMap((stretch) => (stretch.value === null ? [] : [stretch.value]));
        for (const value of values) {
          if (entry.unit === "PERCENT" && value !== 0) {
            expect(Math.abs(value), entry.id).toBeGreaterThanOrEqual(1);
          }
        }
      }
      const fields = new Set(FUNDAMENTAL_METRICS.map((metric) => metric.field));
      for (const key of Object.keys(qaFundamentalFields(159 * 5))) {
        expect(fields.has(key as never), key).toBe(true);
      }
    });
  });

  describe("valuation inputs", () => {
    const firstMonday = prices[0]!.date;
    const SEED_SYNC = `${TODAY}T12:00:00.000Z`;
    const earlySync = `${qaValuationWeekMonday(firstMonday, QA_VALUATION_EARLY_SYNC_WEEK)}T12:00:00.000Z`;

    /** The seeded filings as the store dates them: public the day after filing, observed by their sync. */
    const statements: FinancialStatement[] = QA_VALUATION_QUARTERS.flatMap(
      (quarter) =>
        qaValuationDrafts(SECURITY_ID, firstMonday, quarter).map((draft) => ({
          ...draft,
          availableFromDate: addDays(draft.filingDate, 1),
          observedAt:
            quarter.observed === "BEFORE_REBASE" ? earlySync : SEED_SYNC,
          contentHash: `${draft.statementType}:${quarter.index}`,
        })),
    );
    const effective = qaValuationWeekMonday(
      firstMonday,
      QA_VALUATION_REBASE.week,
    );
    const timeline = buildValuationTimeline({
      securityId: SECURITY_ID,
      currency: "USD",
      statements,
      verifiedAt: `${qaValuationWeekMonday(firstMonday, QA_VALUATION_VERIFIED_WEEK)}T12:00:00.000Z`,
      events: [
        {
          securityId: SECURITY_ID,
          generation: 1,
          kind: "MEASURED",
          effectiveDate: effective,
          priceRatio: QA_VALUATION_REBASE.priceRatio,
          detectedAt: `${addDays(effective, 1)}T12:00:00.000Z`,
          evidence: {
            runs: [],
            comparedSessions: 0,
            changedSessions: 0,
            unfittedSessions: 0,
          },
        },
      ],
      splits: [],
    });
    const columns = valuationRatioColumns({
      timeline,
      dates: prices.map((price) => price.date),
      closes: prices.map((price) => price.close),
      ratios: VALUATION_RATIO_IDS,
    });

    it("covers exactly the five catalog ratios, in catalog order", () => {
      // A sixth ratio added to the catalog has no row here and fails, so the browser suite's
      // coverage of it is a deliberate change.
      expect(Object.keys(QA_VALUATION_AVAILABILITY)).toEqual([
        ...VALUATION_RATIO_IDS,
      ]);
      expect(QA_VALUATION_HISTORY_WEEKS * 5).toBe(prices.length);
    });

    it("dates every quarter on the seeded calendar: filed on a Sunday, public from the Monday after", () => {
      QA_VALUATION_QUARTERS.forEach((quarter, index) => {
        const [income] = qaValuationDrafts(SECURITY_ID, firstMonday, quarter);
        const publicFrom = addDays(income!.filingDate, 1);
        expect(publicFrom).toBe(
          qaValuationWeekMonday(firstMonday, qaValuationPublicWeek(index)),
        );
        expect(new Date(`${income!.filingDate}T00:00:00Z`).getUTCDay()).toBe(0);
        expect(income!.fiscalDate < income!.filingDate).toBe(true);
        // Consecutive fiscal quarters, four to a fiscal year.
        expect(income!.period).toBe(`Q${(index % 4) + 1}`);
      });
      expect(qaValuationPublicWeek(11)).toBeLessThan(
        QA_VALUATION_HISTORY_WEEKS,
      );
      expect(qaValuationPublicWeek(12)).toBeGreaterThanOrEqual(
        QA_VALUATION_HISTORY_WEEKS,
      );
    });

    it("is available exactly where the hand-written table says, under the production calculation", () => {
      let compared = 0;
      for (const ratioId of VALUATION_RATIO_IDS) {
        const column = columns.get(ratioId) as Float64Array;
        prices.forEach((price, index) => {
          const week = Math.floor(index / 5);
          const available = qaValuationAvailable(
            ratioId as QaValuationRatioId,
            week,
          );
          expect(
            Number.isFinite(column[index]),
            `${price.date} ${ratioId}`,
          ).toBe(available);
          compared += 1;
        });
      }
      expect(compared).toBe(prices.length * VALUATION_RATIO_IDS.length);
      // The interior gap the browser suite asserts lies inside the default one-year window, and so
      // does a negative EV/EBITDA stretch before it.
      expect(QA_VALUATION_WITHHELD.fromWeek).toBeGreaterThan(
        QA_VALUATION_HISTORY_WEEKS - 52,
      );
      expect(QA_VALUATION_NET_CASH.fromWeek).toBeGreaterThan(
        QA_VALUATION_HISTORY_WEEKS - 52,
      );
    });

    it("reads EV/EBITDA negative exactly while the net cash is the latest balance sheet", () => {
      const ev = columns.get("EV_TO_EBITDA_TTM") as Float64Array;
      prices.forEach((price, index) => {
        const week = Math.floor(index / 5);
        if (!Number.isFinite(ev[index])) {
          return;
        }
        const negative =
          week >= QA_VALUATION_NET_CASH.fromWeek &&
          week < QA_VALUATION_NET_CASH.untilWeek;
        expect(ev[index]! < 0, price.date).toBe(negative);
      });
    });

    it("reads the restored close before the re-base, and resumes on its own basis after it", () => {
      const pe = columns.get("PRICE_TO_EARNINGS_TTM") as Float64Array;
      const lastBefore = 130 * 5 - 1;
      const firstAfter = 149 * 5;
      // Hand-computed: K = 1.05 on 1,000,000 shares over 12.5M (quarters 6-9) before the event;
      // K = 1 over 17.5M (quarters 8-11) once quarter 11 is public.
      expect(pe[lastBefore]).toBeCloseTo(
        (prices[lastBefore]!.close * 1.05 * 1_000_000) / 12_500_000,
        9,
      );
      expect(pe[firstAfter]).toBeCloseTo(
        (prices[firstAfter]!.close * 1_000_000) / 17_500_000,
        9,
      );
    });
  });
});
