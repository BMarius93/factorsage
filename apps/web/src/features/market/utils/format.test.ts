import { describe, expect, it } from "vitest";
import {
  changeTone,
  formatChangePercent,
  formatMarketValue,
  formatSessionDate,
  marketCardDescription,
} from "./format";

describe("formatMarketValue", () => {
  it("reads a four- or five-figure index as a whole number", () => {
    // Two decimals on 7,637.05 is noise nobody tracks, and it costs the width a phone does not have.
    expect(formatMarketValue(7637.05)).toBe("7,637");
    expect(formatMarketValue(51778.04)).toBe("51,778");
  });

  it("keeps two decimals where the hundredths are the part that moves", () => {
    expect(formatMarketValue(15.43)).toBe("15.43");
    expect(formatMarketValue(999.994)).toBe("999.99");
  });
});

describe("formatChangePercent", () => {
  it("always states the direction", () => {
    expect(formatChangePercent(1.1287)).toBe("+1.13%");
    expect(formatChangePercent(-12.8741)).toBe("−12.87%");
    expect(formatChangePercent(0)).toBe("+0.00%");
  });
});

describe("changeTone", () => {
  it("is flat when there is no percentage to state", () => {
    // An absent change is not a zero change: a single observation cannot say the market was flat.
    expect(changeTone(undefined)).toBe("flat");
    expect(changeTone(0)).toBe("flat");
    expect(changeTone(0.01)).toBe("positive");
    expect(changeTone(-0.01)).toBe("negative");
  });
});

describe("formatSessionDate", () => {
  it("renders the exchange session, not the reader's local day", () => {
    // Read through a local zone, 2026-09-17 becomes the 16th for anyone west of Greenwich.
    expect(formatSessionDate("2026-09-17")).toBe("17 Sep");
    expect(formatSessionDate("2026-01-02")).toBe("2 Jan");
  });

  it("returns an unparseable value unchanged rather than inventing a date", () => {
    expect(formatSessionDate("not-a-date")).toBe("not-a-date");
  });
});

describe("marketCardDescription", () => {
  it("conveys the value, the session and the direction without the chart", () => {
    expect(
      marketCardDescription({
        code: "SP500_INDEX",
        label: "S&P 500",
        status: "AVAILABLE",
        value: 7637.05,
        previousClose: 7551.81,
        changePercent: 1.1287,
        sessionDate: "2026-09-17",
        sparkline: [],
      }),
    ).toBe(
      "S&P 500: 7,637 at the close on 17 Sep, up 1.13% on the previous session.",
    );
  });

  it("says down for a fall", () => {
    expect(
      marketCardDescription({
        code: "VIX_INDEX",
        label: "VIX",
        status: "AVAILABLE",
        value: 15.43,
        changePercent: -12.8741,
        sessionDate: "2026-09-17",
        sparkline: [],
      }),
    ).toContain("down 12.87% on the previous session");
  });

  it("says there is no data rather than describing a number it does not have", () => {
    expect(
      marketCardDescription({
        code: "DJIA_INDEX",
        label: "DJIA",
        status: "UNAVAILABLE",
        sparkline: [],
      }),
    ).toBe("DJIA: no recent data available.");
  });
});
