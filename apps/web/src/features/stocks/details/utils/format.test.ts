import { describe, expect, it } from "vitest";
import {
  formatCompactNumber,
  formatInteger,
  formatLocalDate,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  formatWebsiteHost,
} from "./format";

describe("formatMoney", () => {
  it("formats USD with two decimals", () => {
    expect(formatMoney(232.139, "USD")).toBe("$232.14");
  });

  it("respects the security's own currency", () => {
    expect(formatMoney(100, "EUR")).toBe("€100.00");
  });
});

describe("formatSignedMoney", () => {
  it("prefixes gains with a plus", () => {
    expect(formatSignedMoney(2.315, "USD")).toBe("+$2.32");
  });

  it("keeps losses negative", () => {
    expect(formatSignedMoney(-2.315, "USD")).toBe("-$2.32");
  });

  it("leaves zero unsigned", () => {
    expect(formatSignedMoney(0, "USD")).toBe("$0.00");
  });
});

describe("formatSignedPercent", () => {
  it("converts a fraction into a signed percent", () => {
    expect(formatSignedPercent(0.0124)).toBe("+1.24%");
    expect(formatSignedPercent(-0.0124)).toBe("-1.24%");
  });
});

describe("formatCompactNumber", () => {
  it("abbreviates large counts", () => {
    expect(formatCompactNumber(41_237_500)).toBe("41.2M");
    expect(formatCompactNumber(1_500)).toBe("1.5K");
    expect(formatCompactNumber(2_100_000_000)).toBe("2.1B");
  });

  it("leaves small counts alone", () => {
    expect(formatCompactNumber(950)).toBe("950");
  });
});

describe("formatInteger", () => {
  it("groups thousands", () => {
    expect(formatInteger(164000)).toBe("164,000");
  });
});

describe("formatLocalDate", () => {
  it("renders a canonical date without timezone drift", () => {
    expect(formatLocalDate("2026-08-28")).toBe("Aug 28, 2026");
    expect(formatLocalDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("falls back to the raw string for unparseable input", () => {
    expect(formatLocalDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatWebsiteHost", () => {
  it("reduces a URL to its host", () => {
    expect(formatWebsiteHost("https://www.apple.com/investor/")).toBe(
      "apple.com",
    );
  });

  it("returns invalid input unchanged", () => {
    expect(formatWebsiteHost("not a url")).toBe("not a url");
  });
});
