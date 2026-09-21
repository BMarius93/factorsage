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
});
