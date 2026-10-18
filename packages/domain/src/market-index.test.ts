import { describe, expect, it } from "vitest";
import {
  isMarketIndexKey,
  isTradeableIndexResolution,
  peakSimultaneousMembers,
  pointInTimeIndexUniverseForList,
  SP500_HISTORICAL_PIT_UNIVERSE,
} from "./market-index.js";

describe("point-in-time index universes", () => {
  it("names the S&P 500 universe by its List's systemKey and nothing else", () => {
    expect(pointInTimeIndexUniverseForList("sp500-historical-pit")).toBe(
      SP500_HISTORICAL_PIT_UNIVERSE,
    );
    expect(pointInTimeIndexUniverseForList("sp500-growth-leaders")).toBeNull();
    expect(pointInTimeIndexUniverseForList(null)).toBeNull();
    expect(isMarketIndexKey("SP500")).toBe(true);
    expect(isMarketIndexKey("DJIA")).toBe(false);
  });

  it("treats only resolved constituents as tradeable", () => {
    expect(isTradeableIndexResolution("RESOLVED")).toBe(true);
    expect(isTradeableIndexResolution("RESOLVED_PARTIAL")).toBe(true);
    expect(isTradeableIndexResolution("NO_PROVIDER_DATA")).toBe(false);
    expect(isTradeableIndexResolution("IDENTITY_REJECTED")).toBe(false);
    expect(isTradeableIndexResolution("NOT_ADMISSIBLE")).toBe(false);
    expect(isTradeableIndexResolution("PENDING")).toBe(false);
  });
});

describe("peakSimultaneousMembers", () => {
  const period = { from: "2000-01-01", to: "2000-12-31" } as const;

  it("counts members at once, not distinct members over the period", () => {
    // A replaced by B on 2000-07-01: two securities, never both members.
    const result = peakSimultaneousMembers(
      [
        {
          mode: "CUSTOM",
          ranges: [{ startDate: "1990-01-01", endDate: "2000-06-30" }],
        },
        {
          mode: "CUSTOM",
          ranges: [{ startDate: "2000-07-01", endDate: null }],
        },
      ],
      period,
    );
    expect(result).toEqual({ peak: 1, date: "2000-01-01" });
  });

  it("finds an overlap, inclusive on both ends", () => {
    const result = peakSimultaneousMembers(
      [
        {
          mode: "CUSTOM",
          ranges: [{ startDate: "1999-01-01", endDate: "2000-07-01" }],
        },
        {
          mode: "CUSTOM",
          ranges: [{ startDate: "2000-07-01", endDate: null }],
        },
      ],
      period,
    );
    expect(result).toEqual({ peak: 2, date: "2000-07-01" });
  });

  it("counts FULL members on every date and ignores periods outside the window", () => {
    const result = peakSimultaneousMembers(
      [
        { mode: "FULL", ranges: [] },
        {
          mode: "CUSTOM",
          ranges: [
            { startDate: "1980-01-01", endDate: "1985-01-01" },
            { startDate: "2003-01-01", endDate: null },
          ],
        },
        {
          mode: "CUSTOM",
          ranges: [{ startDate: "2000-03-01", endDate: "2000-03-31" }],
        },
      ],
      period,
    );
    expect(result).toEqual({ peak: 2, date: "2000-03-01" });
  });

  it("reports nothing for an empty or inverted period", () => {
    expect(peakSimultaneousMembers([], period)).toEqual({
      peak: 0,
      date: null,
    });
    expect(
      peakSimultaneousMembers([{ mode: "FULL", ranges: [] }], {
        from: "2001-01-01",
        to: "2000-01-01",
      }),
    ).toEqual({ peak: 0, date: null });
  });
});
