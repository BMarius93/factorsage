import { describe, expect, it } from "vitest";
import {
  alternativeDataAvailabilityDate,
  classifyCongressAssetClass,
  classifyCongressOwner,
  classifyCongressTransaction,
  classifyInsiderTransaction,
  insiderRolesOf,
  insiderTransactionCode,
  insiderTransactionValue,
  isCongressTradeStrategyEligible,
  isOpenMarketInsiderTrade,
  parseDisclosedAmountRange,
} from "./alternative-data.js";

describe("alternativeDataAvailabilityDate", () => {
  it("credits the day after publication, never the publication date itself", () => {
    expect(alternativeDataAvailabilityDate("2026-09-24")).toBe("2026-09-25");
  });

  it("crosses a month and a year boundary", () => {
    expect(alternativeDataAvailabilityDate("2026-01-31")).toBe("2026-02-01");
    expect(alternativeDataAvailabilityDate("2025-12-31")).toBe("2026-01-01");
  });

  it("crosses a leap day", () => {
    expect(alternativeDataAvailabilityDate("2028-02-28")).toBe("2028-02-29");
  });
});

describe("insider transaction classification", () => {
  it("reads the SEC code out of the provider's own label", () => {
    expect(insiderTransactionCode("S-Sale")).toBe("S");
    expect(insiderTransactionCode("M-Exempt")).toBe("M");
    expect(insiderTransactionCode("P")).toBe("P");
    expect(insiderTransactionCode("purchase")).toBeUndefined();
  });

  it("treats only P and S as discretionary open-market trades", () => {
    expect(classifyInsiderTransaction("P-Purchase")).toBe(
      "OPEN_MARKET_PURCHASE",
    );
    expect(classifyInsiderTransaction("S-Sale")).toBe("OPEN_MARKET_SALE");
    expect(isOpenMarketInsiderTrade(classifyInsiderTransaction("P-Purchase"))).toBe(
      true,
    );
  });

  it("never reports an award, gift, exercise or withholding as a purchase", () => {
    // The whole point of the domain: an acquisition is not a decision to buy.
    expect(classifyInsiderTransaction("A-Award")).toBe("AWARD");
    expect(classifyInsiderTransaction("G-Gift")).toBe("GIFT");
    expect(classifyInsiderTransaction("M-Exempt")).toBe("OPTION_EXERCISE");
    expect(classifyInsiderTransaction("X-InTheMoney")).toBe("OPTION_EXERCISE");
    expect(classifyInsiderTransaction("C-Conversion")).toBe("CONVERSION");
    expect(classifyInsiderTransaction("F-InKind")).toBe(
      "DISPOSITION_TO_ISSUER",
    );
    expect(classifyInsiderTransaction("D-Return")).toBe(
      "DISPOSITION_TO_ISSUER",
    );
    for (const type of [
      "A-Award",
      "G-Gift",
      "M-Exempt",
      "C-Conversion",
      "F-InKind",
      "D-Return",
      "J-Other",
      "",
    ]) {
      expect(isOpenMarketInsiderTrade(classifyInsiderTransaction(type))).toBe(
        false,
      );
    }
  });

  it("classifies an unrecognized code as OTHER rather than guessing", () => {
    expect(classifyInsiderTransaction("Z-Something")).toBe("OTHER");
    expect(classifyInsiderTransaction("")).toBe("OTHER");
  });
});

describe("insiderRolesOf", () => {
  it("reads a live provider string", () => {
    expect(insiderRolesOf("officer: SVP, GC and Government Affairs")).toEqual([
      "OFFICER",
    ]);
  });

  it("returns every role one string states", () => {
    expect(insiderRolesOf("officer: President and CEO")).toEqual([
      "CEO",
      "PRESIDENT",
      "OFFICER",
    ]);
    expect(insiderRolesOf("director, 10 percent owner")).toEqual([
      "DIRECTOR",
      "TEN_PERCENT_OWNER",
    ]);
  });

  it("recognizes a spelled-out title without the abbreviation", () => {
    expect(insiderRolesOf("Chief Financial Officer")).toEqual([
      "CFO",
      "OFFICER",
    ]);
  });

  it("never returns an empty list", () => {
    expect(insiderRolesOf(undefined)).toEqual(["OTHER"]);
    expect(insiderRolesOf("   ")).toEqual(["OTHER"]);
    expect(insiderRolesOf("beneficial holder")).toEqual(["OTHER"]);
  });
});

describe("insiderTransactionValue", () => {
  it("multiplies shares by price when the provider gave both", () => {
    expect(
      insiderTransactionValue({ securitiesTransacted: 2399, price: 340.06 }),
    ).toBeCloseTo(815_803.94, 2);
  });

  it("reports no value for an award priced at zero", () => {
    // A live example: `M-Exempt` of 30,104 restricted units at price 0.
    expect(
      insiderTransactionValue({ securitiesTransacted: 30_104, price: 0 }),
    ).toBeUndefined();
  });

  it("reports no value when a factor is missing", () => {
    expect(insiderTransactionValue({ price: 10 })).toBeUndefined();
    expect(
      insiderTransactionValue({ securitiesTransacted: 10 }),
    ).toBeUndefined();
  });

  it("uses the absolute share count, so a signed disposition still has a value", () => {
    expect(
      insiderTransactionValue({ securitiesTransacted: -100, price: 5 }),
    ).toBe(500);
  });
});

describe("congressional normalization", () => {
  it("folds partial and full sales into one kind", () => {
    expect(classifyCongressTransaction("Purchase")).toBe("PURCHASE");
    expect(classifyCongressTransaction("Sale")).toBe("SALE");
    expect(classifyCongressTransaction("Sale (Full)")).toBe("SALE");
    expect(classifyCongressTransaction("Sale (Partial)")).toBe("SALE");
    expect(classifyCongressTransaction("Exchange")).toBe("EXCHANGE");
    expect(classifyCongressTransaction("Something else")).toBe("OTHER");
  });

  it("keeps an unstated owner distinct from self", () => {
    expect(classifyCongressOwner("Self")).toBe("SELF");
    expect(classifyCongressOwner("Spouse")).toBe("SPOUSE");
    expect(classifyCongressOwner("Joint")).toBe("JOINT");
    expect(classifyCongressOwner("")).toBe("UNSPECIFIED");
    expect(classifyCongressOwner(undefined)).toBe("UNSPECIFIED");
  });

  it("admits only common stock to the strategy metrics", () => {
    expect(classifyCongressAssetClass("Stock")).toBe("STOCK");
    expect(classifyCongressAssetClass("Stock Option")).toBe("STOCK_OPTION");
    expect(classifyCongressAssetClass("Corporate Bond")).toBe("BOND");
    expect(classifyCongressAssetClass("Municipal Security")).toBe("OTHER");
    expect(classifyCongressAssetClass("Cryptocurrency")).toBe("CRYPTO");
    expect(classifyCongressAssetClass(undefined)).toBe("OTHER");

    expect(isCongressTradeStrategyEligible({ assetClass: "STOCK" })).toBe(true);
    for (const assetClass of [
      "STOCK_OPTION",
      "BOND",
      "FUND",
      "CRYPTO",
      "OTHER",
    ] as const) {
      expect(isCongressTradeStrategyEligible({ assetClass })).toBe(false);
    }
  });
});

describe("parseDisclosedAmountRange", () => {
  it("keeps both bounds and the provider's own text", () => {
    expect(parseDisclosedAmountRange("$15,001 - $50,000")).toEqual({
      raw: "$15,001 - $50,000",
      lowerBound: 15_001,
      upperBound: 50_000,
    });
  });

  it("parses a band written without spaces", () => {
    expect(parseDisclosedAmountRange("$1,001-$15,000")).toEqual({
      raw: "$1,001-$15,000",
      lowerBound: 1_001,
      upperBound: 15_000,
    });
  });

  it("leaves an open-ended top band without an upper bound", () => {
    expect(parseDisclosedAmountRange("Over $50,000,000")).toEqual({
      raw: "Over $50,000,000",
      lowerBound: 50_000_000,
    });
    expect(parseDisclosedAmountRange("$50,000,001 +")).toEqual({
      raw: "$50,000,001 +",
      lowerBound: 50_000_001,
    });
  });

  it("never invents a midpoint or a zero", () => {
    const parsed = parseDisclosedAmountRange("$1,001 - $15,000");
    expect(Object.keys(parsed).sort()).toEqual([
      "lowerBound",
      "raw",
      "upperBound",
    ]);
    expect(parseDisclosedAmountRange("undisclosed")).toEqual({
      raw: "undisclosed",
    });
    expect(parseDisclosedAmountRange(undefined)).toEqual({ raw: "" });
  });
});
