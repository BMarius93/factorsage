import { describe, expect, it } from "vitest";
import {
  describeReturn,
  describeSparkline,
  formatReturn,
  formatSessionDate,
  returnDirection,
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

describe("returnDirection", () => {
  it("follows the displayed return, and has no direction without one", () => {
    expect(returnDirection(12)).toBe("positive");
    expect(returnDirection(-3)).toBe("negative");
    expect(returnDirection(null)).toBe("flat");
    // Rounds to 0.0%, so the line beside it is never green.
    expect(returnDirection(0.01)).toBe("flat");
    expect(returnDirection(-0.04)).toBe("flat");
  });
});

describe("session dates", () => {
  it("reads the session as a calendar date, not an instant", () => {
    expect(formatSessionDate("2026-10-09")).toBe("9 Oct");
    expect(formatSessionDate("2026-09-01")).toBe("1 Sep");
    expect(formatSessionDate("not-a-date")).toBe("not-a-date");
  });
});

describe("describeSparkline", () => {
  it("says which period the line covers, the sessions it spans and where it went", () => {
    expect(
      describeSparkline(
        "SPY",
        "1Y",
        { startDate: "2025-10-09", endDate: "2026-10-09", values: [100, 121.04] },
        21.04,
      ),
    ).toBe("SPY 1 year trend, closes from 9 Oct 2025 to 9 Oct 2026, up 21.04%");
    expect(
      describeSparkline(
        "XLE",
        "1W",
        { startDate: "2026-10-02", endDate: "2026-10-09", values: [100, 98.8] },
        -1.2,
      ),
    ).toBe("XLE 1 week trend, closes from 2 Oct 2026 to 9 Oct 2026, down 1.20%");
    expect(
      describeSparkline(
        "GLD",
        "YTD",
        { startDate: "2025-12-31", endDate: "2026-10-09", values: [100, 100] },
        0,
      ),
    ).toBe("GLD year to date trend, closes from 31 Dec 2025 to 9 Oct 2026, unchanged");
  });

  it("says when a period has no line", () => {
    expect(describeSparkline("GLD", "6M", null, null)).toBe(
      "GLD 6 months trend: not available",
    );
  });
});
