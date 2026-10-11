import { describe, expect, it } from "vitest";
import {
  describeReturn,
  describeSparkline,
  formatLongSessionDate,
  formatReturn,
  formatSessionDate,
  sparklineTone,
} from "./format";

describe("formatReturn", () => {
  it("signs every non-zero return, with a real minus sign", () => {
    expect(formatReturn(4.3149)).toEqual({ text: "+4.3%", tone: "positive" });
    expect(formatReturn(-1.2)).toEqual({ text: "−1.2%", tone: "negative" });
    expect(formatReturn(-1.2).text.startsWith("−")).toBe(true);
    expect(formatReturn(126.48)).toEqual({ text: "+126.5%", tone: "positive" });
    expect(formatReturn(-1234.5).text).toBe("−1,234.5%");
  });

  it("calls anything that rounds to nothing zero, never a coloured +0.0%", () => {
    expect(formatReturn(0)).toEqual({ text: "0.0%", tone: "zero" });
    expect(formatReturn(0.04)).toEqual({ text: "0.0%", tone: "zero" });
    expect(formatReturn(-0.04)).toEqual({ text: "0.0%", tone: "zero" });
  });

  it("keeps an unavailable return distinguishable from zero", () => {
    expect(formatReturn(null)).toEqual({ text: "—", tone: "unavailable" });
    expect(formatReturn(Number.NaN)).toEqual({ text: "—", tone: "unavailable" });
    expect(formatReturn(null).text).not.toBe(formatReturn(0).text);
  });
});

describe("describeReturn", () => {
  it("states the period and the direction in words", () => {
    expect(describeReturn("1M", 4.3149)).toBe("1 month: up 4.31%");
    expect(describeReturn("YTD", -12.5)).toBe("Year to date: down 12.50%");
    expect(describeReturn("1W", 0.001)).toBe("1 week: unchanged");
    expect(describeReturn("1Y", null)).toBe("1 year: not available");
  });
});

describe("sparklineTone", () => {
  it("follows the 1Y return, and has no direction without one", () => {
    expect(sparklineTone({ returns: returns(12) })).toBe("positive");
    expect(sparklineTone({ returns: returns(-3) })).toBe("negative");
    expect(sparklineTone({ returns: returns(null) })).toBe("flat");
    expect(sparklineTone({ returns: returns(0.01) })).toBe("flat");
  });
});

describe("session dates", () => {
  it("reads the session as a calendar date, not an instant", () => {
    expect(formatSessionDate("2026-10-09")).toBe("9 Oct");
    expect(formatLongSessionDate("2026-10-09")).toBe("Fri 9 Oct 2026");
    expect(formatLongSessionDate("2026-09-01")).toBe("Tue 1 Sep 2026");
    expect(formatSessionDate("not-a-date")).toBe("not-a-date");
  });
});

describe("describeSparkline", () => {
  it("says what the line covers and where it went", () => {
    expect(
      describeSparkline({
        ticker: "SPY",
        returns: returns(21.04),
        sparkline: { startDate: "2025-10-09", endDate: "2026-10-09", values: [100, 121.04] },
      }),
    ).toBe("SPY one-year trend, weekly closes from 9 Oct 2025 to 9 Oct 2026, up 21.04%");
  });

  it("does not call a short history a year", () => {
    expect(
      describeSparkline({
        ticker: "XLC",
        returns: returns(null),
        sparkline: { startDate: "2026-05-01", endDate: "2026-10-09", values: [100, 104] },
      }),
    ).toBe("XLC trend, weekly closes from 1 May 2026 to 9 Oct 2026");
    expect(describeSparkline({ ticker: "GLD", returns: returns(null), sparkline: null })).toBe(
      "GLD: no trend available",
    );
  });
});

function returns(year: number | null) {
  return { "1W": 1, "1M": 1, "3M": 1, "6M": 1, YTD: 1, "1Y": year };
}
