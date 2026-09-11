import { describe, expect, it } from "vitest";
import { ComparisonScenarios } from "./comparison.js";
import { moneyString, toNumber, type MoneyValue } from "./money.js";

/**
 * The funded benchmark scenario, and the capital it must not lose.
 *
 * `funded-scenarios/strategy-benchmark-cash@1` says the three scenarios receive **the same external
 * cash flows on the same dates** and differ only in what happens to the money. That is the whole
 * point of the comparison: a gap between the lines is a difference in what the money *did*, never
 * in how much of it there was.
 *
 * So the property under test is conservation. Every dollar that arrives buys benchmark shares, and
 * at an unchanged price the scenario is worth exactly what was put into it — not "to the cent", and
 * not "to within a rounding step per contribution".
 *
 * The defect this pins: benchmark shares were briefly truncated to the *persisted position* share
 * scale of ten decimals, and the unspent remainder — up to `price x 1e-10` per funding — was then
 * set to zero rather than carried. Benchmark shares are internal and are never persisted, so there
 * was nothing for that scale to protect; it silently destroyed capital, once per contribution, for
 * three hundred and sixty contributions.
 */

const mark = (value: MoneyValue | null): string =>
  value === null ? "null" : moneyString(value);

describe("capital is conserved at an unchanged price", () => {
  it("invests one dollar in full", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1);
    expect(mark(scenarios.markBenchmark(412.19))).toBe("1.000000");
    expect(scenarios.pendingCapital).toBe(0);
  });

  it("invests a billion dollars in full", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000_000_000);
    expect(mark(scenarios.markBenchmark(412.19))).toBe("1000000000.000000");
  });

  it("keeps three hundred and sixty one-dollar contributions whole", () => {
    // The measurement that exposes truncation: the deficit is a fraction of a share per funding,
    // invisible once and worth about fifteen millionths of a dollar after three hundred of them.
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1);
    let value = scenarios.markBenchmark(412.19);
    for (let month = 1; month < 360; month += 1) {
      scenarios.fund(1);
      value = scenarios.markBenchmark(412.19);
    }
    expect(mark(value)).toBe("360.000000");
    expect(moneyString(scenarios.cashBaselineValue)).toBe("360.000000");
  });

  it("keeps them whole at a price whose division never terminates", () => {
    // 1/3, 1/7 and 1/11 all repeat forever in base ten. A representation that has to stop
    // somewhere is exactly where capital goes missing, so these are the prices to ask about.
    for (const price of [3, 7, 11, 0.0003]) {
      const scenarios = new ComparisonScenarios();
      let value: MoneyValue | null = null;
      for (let month = 0; month < 240; month += 1) {
        scenarios.fund(1);
        value = scenarios.markBenchmark(price);
      }
      expect([price, mark(value)]).toEqual([price, "240.000000"]);
    }
  });

  it("keeps the C08 contract maximum whole across thirty years of contributions", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000_000_000);
    let value = scenarios.markBenchmark(1_234.56789012);
    for (let month = 1; month < 360; month += 1) {
      scenarios.fund(10_000_000);
      value = scenarios.markBenchmark(1_234.56789012);
    }
    // 1,000,000,000 + 359 x 10,000,000
    expect(mark(value)).toBe("4590000000.000000");
    expect(moneyString(scenarios.cashBaselineValue)).toBe("4590000000.000000");
  });
});

describe("the scenario tracks the benchmark, not the contributions", () => {
  it("marks the whole holding to the current close", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000);
    expect(mark(scenarios.markBenchmark(100))).toBe("1000.000000");
    // Ten shares at 110.
    expect(mark(scenarios.markBenchmark(110))).toBe("1100.000000");
  });

  it("buys each contribution at the price in effect when it arrived", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000);
    scenarios.markBenchmark(100); // 10 shares
    scenarios.fund(900);
    // 900 at 90 buys 10 more; twenty shares at 90.
    expect(mark(scenarios.markBenchmark(90))).toBe("1800.000000");
    // Which is a different number from `contributedCapital x (close / openingClose)` = 1,710.
    expect(mark(scenarios.markBenchmark(120))).toBe("2400.000000");
  });

  it("reports no value at all before the benchmark has a close", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000);
    expect(scenarios.markBenchmark(null)).toBeNull();
    // And the capital is still waiting, not spent and not lost.
    expect(scenarios.pendingCapital).toBe(1_000);
    expect(mark(scenarios.markBenchmark(100))).toBe("1000.000000");
    expect(scenarios.pendingCapital).toBe(0);
  });

  it("holds capital rather than discarding it when the close is not a price", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(500);
    expect(mark(scenarios.markBenchmark(0))).toBe("0.000000");
    expect(scenarios.pendingCapital).toBe(500);
    expect(mark(scenarios.markBenchmark(50))).toBe("500.000000");
  });
});

describe("the cash baseline", () => {
  it("is external funding only, and never the strategy's own balance", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(1_000);
    scenarios.fund(100);
    expect(moneyString(scenarios.cashBaselineValue)).toBe("1100.000000");
    // Marking the benchmark does not move it: the cash scenario is never invested.
    scenarios.markBenchmark(412.19);
    expect(moneyString(scenarios.cashBaselineValue)).toBe("1100.000000");
  });

  it("ignores a funding that is not a positive amount", () => {
    const scenarios = new ComparisonScenarios();
    scenarios.fund(0);
    scenarios.fund(-100);
    scenarios.fund(Number.NaN);
    expect(moneyString(scenarios.cashBaselineValue)).toBe("0.000000");
    expect(toNumber(scenarios.cashBaselineValue)).toBe(0);
  });
});
