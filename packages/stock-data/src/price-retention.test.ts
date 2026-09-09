import { BACKTEST_MAX_PERIOD_YEARS } from "@intrinsic/contracts";
import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import {
  DAILY_MOVING_AVERAGES,
  DAILY_OSCILLATORS,
  WEEKLY_MOVING_AVERAGES,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays, subtractYears } from "./dates.js";
import {
  DERIVED_SERIES_WARMUP_DAYS,
  PRICE_RETENTION_WARMUP_YEARS,
  priceRetentionYears,
  VALUATION_FUNDAMENTALS_WARMUP_YEARS,
  fundamentalsDatasetVariant,
} from "./service.js";

/**
 * The separation between what the product exposes and what the loader retains.
 *
 * Everything here is a policy assertion rather than a behaviour test: the behaviour lives in
 * `price-retention.integration.test.ts`, which drives the real loader against real PostgreSQL and
 * Redis. What this file protects is the boundary itself — that one number did not quietly come to
 * mean two things again, and that widening raw-price retention did not drag a product limit, a
 * fundamentals variant or a calendar rule along with it.
 */
describe("product horizon and raw-price retention are separate policies", () => {
  const PRODUCT_HISTORY_YEARS = 30;

  it("keeps every user-facing limit at the product horizon", () => {
    expect(BACKTEST_MAX_PERIOD_YEARS).toBe(PRODUCT_HISTORY_YEARS);
    expect(STOCK_DETAILS_MAX_HISTORY_YEARS).toBe(PRODUCT_HISTORY_YEARS);
  });

  it("retains four extra years of raw prices, and only raw prices", () => {
    expect(PRICE_RETENTION_WARMUP_YEARS).toBe(4);
    expect(priceRetentionYears(PRODUCT_HISTORY_YEARS)).toBe(34);
    // The warm-up is wide enough for the longest catalog series and no wider: a retention horizon
    // that did not clear `DERIVED_SERIES_WARMUP_DAYS` would put the null warm-up values straight
    // back, and one that cleared it by years would be paid for on every cold stock.
    expect(PRICE_RETENTION_WARMUP_YEARS * 365).toBeGreaterThanOrEqual(
      DERIVED_SERIES_WARMUP_DAYS,
    );
    expect((PRICE_RETENTION_WARMUP_YEARS - 1) * 366).toBeLessThan(
      DERIVED_SERIES_WARMUP_DAYS,
    );
  });

  it("derives the warm-up from the catalog registries, not from a literal", () => {
    const longestWeeks = Math.max(
      Math.ceil(
        Math.max(
          ...DAILY_MOVING_AVERAGES.map((average) => average.period),
          ...DAILY_OSCILLATORS.map((oscillator) => oscillator.period),
        ) / 5,
      ),
      ...WEEKLY_MOVING_AVERAGES.map((average) => average.period),
    );
    // 200 completed weeks is the binding series today. Registering a longer one must widen
    // retention with it rather than silently under-warming it.
    expect(longestWeeks).toBe(200);
    expect(DERIVED_SERIES_WARMUP_DAYS).toBe((longestWeeks + 8) * 7);
  });

  it("keeps fundamentals retention anchored to the product horizon", () => {
    // 30 + 7, never 34 + 7. The variant string is the durable consequence: a stock backfilled
    // under `h30:w7` must still read as satisfied after raw-price retention widens, or the whole
    // statement history would be re-downloaded for a policy change that never touched a filing.
    expect(VALUATION_FUNDAMENTALS_WARMUP_YEARS).toBe(7);
    for (const cadence of ["QUARTERLY", "ANNUAL"] as const) {
      expect(fundamentalsDatasetVariant(cadence, PRODUCT_HISTORY_YEARS)).toBe(
        `standard:${cadence === "QUARTERLY" ? "quarter" : "annual"}:v1:h30:w7`,
      );
      expect(
        fundamentalsDatasetVariant(
          cadence,
          priceRetentionYears(PRODUCT_HISTORY_YEARS),
        ),
      ).not.toBe(fundamentalsDatasetVariant(cadence, PRODUCT_HISTORY_YEARS));
    }
  });

  it("advertises no 34-year capability on any shared contract", async () => {
    const contracts = await import("@intrinsic/contracts");
    const advertised = Object.entries(contracts).filter(
      ([name, value]) =>
        typeof value === "number" &&
        value === priceRetentionYears(PRODUCT_HISTORY_YEARS) &&
        /year/i.test(name),
    );
    expect(advertised).toEqual([]);
  });
});

/**
 * One calendar rule for both boundaries.
 *
 * The product horizon and the retention horizon are computed at different call sites, on different
 * days, in the browser and on the server. If they disagreed about 29 February they would disagree
 * about which day a maximum-length backtest may start on, one year in four.
 */
describe("the 30-year and 34-year boundaries share one date rule", () => {
  it("clamps 29 February to 28 February at both horizons", () => {
    expect(subtractYears("2024-02-29", 30)).toBe("1994-02-28");
    expect(subtractYears("2024-02-29", 34)).toBe("1990-02-28");
    // Not a rollover into 1 March, which is what a naive `setUTCFullYear` produces.
    expect(subtractYears("2024-02-29", 30)).not.toBe("1994-03-01");
  });

  it("lands the retention boundary exactly four years before the product boundary", () => {
    for (const today of [
      "2026-09-09",
      "2024-02-29",
      "2025-03-01",
      "2028-02-29",
      "2027-01-01",
      "2026-12-31",
    ]) {
      const product = subtractYears(today, 30);
      const retention = subtractYears(today, 34);
      expect(retention).toBe(subtractYears(product, 4));
      expect(retention < product).toBe(true);
    }
  });

  it("clears the derived warm-up from the product boundary on every leap configuration", () => {
    for (const today of [
      "2026-09-09",
      "2024-02-29",
      "2028-02-29",
      "2100-03-01",
    ]) {
      const product = subtractYears(today, 30);
      const retention = subtractYears(today, priceRetentionYears(30));
      // The whole point of the retention horizon: the 200-week warm-up fits behind the first
      // visible day without running off the retained history.
      expect(retention <= addDays(product, -DERIVED_SERIES_WARMUP_DAYS)).toBe(
        true,
      );
    }
  });
});
