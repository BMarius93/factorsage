import { describe, expect, it } from "vitest";
import {
  formatCompactNumber,
  formatFundamentalValue,
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

describe("formatFundamentalValue", () => {
  it("reads a percentage metric's percentage points as a percent, never rescaled", () => {
    expect(formatFundamentalValue(15.42, "PERCENT")).toBe("15.42%");
    expect(formatFundamentalValue(18.25, "PERCENT")).toBe("18.25%");
    expect(formatFundamentalValue(-8.3, "PERCENT")).toBe("-8.3%");
    expect(formatFundamentalValue(12, "PERCENT")).toBe("12%");
    // Stored at full precision; two decimals are presentation only.
    expect(formatFundamentalValue(18.25384617, "PERCENT")).toBe("18.25%");
    // Grouped rather than exponent notation, however large the reading.
    expect(formatFundamentalValue(1234.5, "PERCENT")).toBe("1,234.5%");
  });

  it("reads a multiple as a raw ratio with at least one decimal", () => {
    expect(formatFundamentalValue(0.75, "MULTIPLE")).toBe("0.75x");
    expect(formatFundamentalValue(1, "MULTIPLE")).toBe("1.0x");
    expect(formatFundamentalValue(5.2, "MULTIPLE")).toBe("5.2x");
    expect(formatFundamentalValue(-0.4, "MULTIPLE")).toBe("-0.4x");
    expect(formatFundamentalValue(8.25, "MULTIPLE")).toBe("8.25x");
  });

  it("never rounds 0.75 to 0.8x, nor a multiple to a whole number", () => {
    expect(formatFundamentalValue(0.75, "MULTIPLE")).not.toBe("0.8x");
    expect(formatFundamentalValue(1.25, "MULTIPLE")).toBe("1.25x");
    expect(formatFundamentalValue(2.05, "MULTIPLE")).toBe("2.05x");
  });

  it("prints a real zero as zero and a signed zero as the same zero", () => {
    expect(formatFundamentalValue(0, "PERCENT")).toBe("0%");
    expect(formatFundamentalValue(-0, "PERCENT")).toBe("0%");
    expect(formatFundamentalValue(0, "MULTIPLE")).toBe("0.0x");
    expect(formatFundamentalValue(-0, "MULTIPLE")).toBe("0.0x");
  });

  it("never prints a small non-zero reading as zero, and never in exponent notation", () => {
    expect(formatFundamentalValue(0.004, "PERCENT")).toBe("0.004%");
    expect(formatFundamentalValue(-0.0031, "PERCENT")).toBe("-0.0031%");
    expect(formatFundamentalValue(0.004, "MULTIPLE")).toBe("0.004x");
    expect(formatFundamentalValue(0.00000001, "MULTIPLE")).toBe("0.00000001x");
    for (const tiny of [0.004, -0.0031, 0.00000001, 1e-8]) {
      expect(formatFundamentalValue(tiny, "PERCENT")).not.toMatch(/e|^-?0%$/i);
      expect(formatFundamentalValue(tiny, "MULTIPLE")).not.toMatch(
        /e|^-?0\.0x$/i,
      );
    }
  });

  it("formats by unit alone, so every metric of a unit reads the same way", () => {
    // No per-metric switch exists to get wrong: the same number reads identically for any
    // percentage metric, and differently only because the unit differs.
    expect(formatFundamentalValue(0.5, "PERCENT")).toBe("0.5%");
    expect(formatFundamentalValue(0.5, "MULTIPLE")).toBe("0.5x");
  });
});
