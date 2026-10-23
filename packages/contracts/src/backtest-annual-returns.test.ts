import { describe, expect, it } from "vitest";
import { backtestAnnualReturns } from "./backtests.js";

/**
 * A year's return is what happened **in that year**, and nothing else.
 *
 * The figure the UI used to show was the cumulative return to the end of each year, which reads as
 * a run that was up 3,146% in 2025 when 2025 itself was flat. These cases pin the replacement: a
 * chain off the canonical time-weighted return index, so contributions never masquerade as
 * performance and no year inherits another year's gains.
 */

/** A growth index of 1.0 is the base the first simulated day is measured from. */
function daily(
  entries: readonly (readonly [string, number])[],
): { date: string; returnIndex: number }[] {
  return entries.map(([date, returnIndex]) => ({ date, returnIndex }));
}

const WHOLE_YEARS = { startDate: "2020-01-01", endDate: "2022-12-31" };

describe("backtestAnnualReturns", () => {
  it("reports a positive year as that year's own growth", () => {
    const [year] = backtestAnnualReturns(
      daily([
        ["2020-06-30", 1.1],
        ["2020-12-31", 1.2],
      ]),
      { startDate: "2020-01-01", endDate: "2020-12-31" },
    );
    expect(year?.year).toBe("2020");
    expect(year?.returnPercent).toBeCloseTo(20, 10);
    expect(year?.simulatedThrough).toBe("2020-12-31");
    expect(year?.partial).toBe(false);
  });

  it("reports a negative year as a loss, not as a smaller cumulative gain", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.5],
        // The portfolio is still up 20% overall, but 2021 itself lost 20%.
        ["2021-12-31", 1.2],
      ]),
      WHOLE_YEARS,
    );
    expect(years.map((entry) => entry.year)).toEqual(["2020", "2021"]);
    expect(years[0]?.returnPercent).toBeCloseTo(50, 10);
    expect(years[1]?.returnPercent).toBeCloseTo(-20, 10);
  });

  it("reports a flat year as exactly zero", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.4],
        ["2021-12-31", 1.4],
      ]),
      WHOLE_YEARS,
    );
    expect(years[1]?.returnPercent).toBe(0);
  });

  it("is never cumulative: a long run's later years do not inherit earlier gains", () => {
    // 10% a year, compounding. Cumulatively that is +33.1% by the third year; each year is +10%.
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.1],
        ["2021-12-31", 1.21],
        ["2022-12-31", 1.331],
      ]),
      WHOLE_YEARS,
    );
    expect(years.map((entry) => entry.returnPercent)).toEqual([
      expect.closeTo(10, 8),
      expect.closeTo(10, 8),
      expect.closeTo(10, 8),
    ]);
  });

  it("chains back to the run's total return, which is what makes it one methodology", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.5],
        ["2021-12-31", 1.2],
        ["2022-12-31", 2.4],
      ]),
      WHOLE_YEARS,
    );
    const chained = years.reduce(
      (total, entry) => total * (1 + entry.returnPercent / 100),
      1,
    );
    // The final growth index, reached by multiplying the yearly figures back together.
    expect(chained).toBeCloseTo(2.4, 10);
  });

  it("does not report monthly contributions as return", () => {
    // Portfolio value doubles over the year, but half of the rise is deposited capital: the index
    // is what knows the difference, which is why the year is read off the index and not off value.
    //
    //   start 100,000 -> contributions 50,000 -> end 200,000
    //   naive (end - start) / start = +100%
    //   time-weighted                = +33.3%
    const naiveStart = 100_000;
    const naiveEnd = 200_000;
    const timeWeightedIndex = 1.3333333333;
    const [year] = backtestAnnualReturns(
      daily([
        ["2020-01-02", 1],
        ["2020-12-31", timeWeightedIndex],
      ]),
      { startDate: "2020-01-01", endDate: "2020-12-31" },
    );
    expect(year?.returnPercent).toBeCloseTo(33.33333, 4);
    expect(year?.returnPercent).not.toBeCloseTo(
      ((naiveEnd - naiveStart) / naiveStart) * 100,
      0,
    );
  });

  it("marks a partial first calendar year and still measures only what was simulated", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-05-11", 1],
        ["2020-12-31", 1.08],
        ["2021-12-31", 1.188],
      ]),
      { startDate: "2020-05-11", endDate: "2021-12-31" },
    );
    expect(years[0]).toMatchObject({ year: "2020", partial: true });
    expect(years[0]?.returnPercent).toBeCloseTo(8, 8);
    // The following whole year is not partial, and is not inflated by the stub year before it.
    expect(years[1]).toMatchObject({ year: "2021", partial: false });
    expect(years[1]?.returnPercent).toBeCloseTo(10, 8);
  });

  it("marks a partial last calendar year", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.2],
        ["2021-03-15", 1.26],
      ]),
      { startDate: "2020-01-01", endDate: "2021-03-15" },
    );
    expect(years[1]).toMatchObject({
      year: "2021",
      partial: true,
      simulatedThrough: "2021-03-15",
    });
    expect(years[1]?.returnPercent).toBeCloseTo(5, 8);
  });

  it("reads the last point of each calendar year whatever order the points arrive in", () => {
    const shuffled = daily([
      ["2021-06-30", 1.15],
      ["2020-12-31", 1.2],
      ["2021-12-31", 1.32],
      ["2020-03-31", 1.05],
    ]);
    const years = backtestAnnualReturns(shuffled, WHOLE_YEARS);
    expect(years.map((entry) => entry.year)).toEqual(["2020", "2021"]);
    expect(years[0]?.returnPercent).toBeCloseTo(20, 8);
    expect(years[1]?.returnPercent).toBeCloseTo(10, 8);
  });

  it("ignores a non-positive index rather than reporting a wipeout from one bad reading", () => {
    const years = backtestAnnualReturns(
      daily([
        ["2020-12-31", 1.2],
        ["2021-06-30", 0],
        ["2021-12-31", 1.44],
      ]),
      WHOLE_YEARS,
    );
    expect(years.map((entry) => entry.year)).toEqual(["2020", "2021"]);
    expect(years[1]?.returnPercent).toBeCloseTo(20, 8);
  });

  it("reports nothing for a run with no simulated day", () => {
    expect(backtestAnnualReturns([], WHOLE_YEARS)).toEqual([]);
  });

  it("reports no benchmark figure when it is given no benchmark base", () => {
    const years = backtestAnnualReturns(
      [
        { date: "2020-12-31", returnIndex: 1.2, benchmarkIndex: 1.1 },
        { date: "2021-12-31", returnIndex: 1.32, benchmarkIndex: 1.21 },
      ],
      WHOLE_YEARS,
    );
    expect(years.map((entry) => entry.benchmarkReturnPercent)).toEqual([
      null,
      null,
    ]);
  });
});

/**
 * The benchmark row of the annual-returns comparison.
 *
 * Its figure for a year is read off the run's own benchmark growth index on **the Strategy's two
 * anchor dates**, so a Strategy cell and the Benchmark cell under it always describe one window —
 * and a window the benchmark did not cover is reported as unavailable, never shortened.
 */
describe("backtestAnnualReturns — benchmark", () => {
  /** Daily points carrying both indices; `null` is a date the benchmark had no value. */
  function paired(
    entries: readonly (readonly [string, number, number | null])[],
  ): { date: string; returnIndex: number; benchmarkIndex: number | null }[] {
    return entries.map(([date, returnIndex, benchmarkIndex]) => ({
      date,
      returnIndex,
      benchmarkIndex,
    }));
  }

  const FROM_START = { indexAtFirstSimulatedDate: 1 };

  it("measures each year on the same dates as the Strategy, not cumulatively", () => {
    const years = backtestAnnualReturns(
      paired([
        ["2020-01-02", 1, 1],
        ["2020-12-31", 1.2, 1.1],
        ["2021-06-30", 1.3, 1.5],
        ["2021-12-31", 1.32, 1.21],
        ["2022-12-30", 0.99, 1.331],
      ]),
      { startDate: "2020-01-02", endDate: "2022-12-30" },
      FROM_START,
    );
    expect(
      years.map((entry) => [
        entry.year,
        entry.simulatedThrough,
        entry.benchmarkReturnPercent,
      ]),
    ).toEqual([
      ["2020", "2020-12-31", expect.closeTo(10, 8)],
      // The mid-year 1.5 is not the year's end: 2021 is 1.21 / 1.1.
      ["2021", "2021-12-31", expect.closeTo(10, 8)],
      ["2022", "2022-12-30", expect.closeTo(10, 8)],
    ]);
  });

  it("chains back to the benchmark's total return over the run", () => {
    const years = backtestAnnualReturns(
      paired([
        ["2020-01-02", 1, 1],
        ["2020-12-31", 1.2, 0.8],
        ["2021-12-31", 1.1, 1.04],
        ["2022-12-30", 1.5, 1.3],
      ]),
      { startDate: "2020-01-02", endDate: "2022-12-30" },
      FROM_START,
    );
    const chained = years.reduce(
      (total, entry) => total * (1 + (entry.benchmarkReturnPercent ?? 0) / 100),
      1,
    );
    expect(chained).toBeCloseTo(1.3, 10);
    expect(years[0]?.benchmarkReturnPercent).toBeCloseTo(-20, 8);
  });

  it("leaves the Strategy's own figures exactly as they were", () => {
    const strategyOnly = backtestAnnualReturns(
      daily([
        ["2020-03-02", 1],
        ["2020-12-31", 1.08],
        ["2021-12-31", 0.972],
        ["2022-06-15", 1.05],
      ]),
      { startDate: "2020-03-02", endDate: "2022-06-15" },
    );
    const withBenchmark = backtestAnnualReturns(
      paired([
        ["2020-03-02", 1, 1],
        ["2020-12-31", 1.08, 1.3],
        ["2021-12-31", 0.972, null],
        ["2022-06-15", 1.05, 1.1],
      ]),
      { startDate: "2020-03-02", endDate: "2022-06-15" },
      FROM_START,
    );
    expect(
      withBenchmark.map(({ benchmarkReturnPercent: _ignored, ...rest }) => rest),
    ).toEqual(
      strategyOnly.map(({ benchmarkReturnPercent: _ignored, ...rest }) => rest),
    );
  });

  it("shares the year's partial flag: a part-year is a part-year for both rows", () => {
    const years = backtestAnnualReturns(
      paired([
        ["2020-05-11", 1, 1],
        ["2020-12-31", 1.08, 1.05],
        ["2021-12-31", 1.188, 1.155],
        ["2022-03-15", 1.2, 1.2],
      ]),
      { startDate: "2020-05-11", endDate: "2022-03-15" },
      FROM_START,
    );
    expect(
      years.map((entry) => [
        entry.year,
        entry.partial,
        entry.benchmarkReturnPercent,
      ]),
    ).toEqual([
      // Measured from the run's first simulated date, like the Strategy's first year.
      ["2020", true, expect.closeTo(5, 8)],
      ["2021", false, expect.closeTo(10, 8)],
      ["2022", true, expect.closeTo((1.2 / 1.155 - 1) * 100, 8)],
    ]);
  });

  it("reports a year the benchmark did not cover from its start as unavailable, not as a shorter return", () => {
    // The benchmark's history begins in June 2020, after the run started: its index is based at
    // 1.0 on that later date, so 2020's figure would cover half the Strategy's window.
    const years = backtestAnnualReturns(
      paired([
        ["2020-01-02", 1, null],
        ["2020-06-01", 1.05, 1],
        ["2020-12-31", 1.1, 1.2],
        ["2021-12-31", 1.21, 1.32],
      ]),
      { startDate: "2020-01-02", endDate: "2021-12-31" },
      { indexAtFirstSimulatedDate: null },
    );
    expect(years.map((entry) => entry.benchmarkReturnPercent)).toEqual([
      null,
      // From the first year-end the benchmark had a value at, the windows agree again.
      expect.closeTo(10, 8),
    ]);
    // The Strategy's figure for the same year is unaffected.
    expect(years[0]?.returnPercent).toBeCloseTo(10, 8);
  });

  it("reports a year whose end has no benchmark reading as unavailable, and the year after too", () => {
    const years = backtestAnnualReturns(
      paired([
        ["2020-12-31", 1.1, 1.1],
        ["2021-12-31", 1.21, null],
        ["2022-12-30", 1.331, 1.331],
      ]),
      { startDate: "2020-01-01", endDate: "2022-12-30" },
      FROM_START,
    );
    // 2022 cannot be measured from a 2021 reading that does not exist; it is not bridged to 2020.
    expect(years.map((entry) => entry.benchmarkReturnPercent)).toEqual([
      expect.closeTo(10, 8),
      null,
      null,
    ]);
  });

  it("reads the same answer off per-year milestones as off the daily series", () => {
    const daily = paired([
      ["2020-01-02", 1, 1],
      ["2020-07-01", 1.04, 1.02],
      ["2020-12-31", 1.08, 1.05],
      ["2021-03-01", 1.1, 1.0],
      ["2021-12-31", 1.188, 1.155],
    ]);
    const milestones = daily.filter((point) => point.date.endsWith("12-31"));
    const period = { startDate: "2020-01-02", endDate: "2021-12-31" };
    expect(backtestAnnualReturns(milestones, period, FROM_START)).toEqual(
      backtestAnnualReturns(daily, period, FROM_START),
    );
  });

  it("ignores a non-finite or non-positive benchmark reading rather than dividing by it", () => {
    const years = backtestAnnualReturns(
      paired([
        ["2020-12-31", 1.1, 0],
        ["2021-12-31", 1.21, Number.NaN],
      ]),
      { startDate: "2020-01-01", endDate: "2021-12-31" },
      FROM_START,
    );
    expect(years.map((entry) => entry.benchmarkReturnPercent)).toEqual([
      null,
      null,
    ]);
  });
});
