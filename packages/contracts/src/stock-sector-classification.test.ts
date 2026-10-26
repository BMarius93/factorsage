import { describe, expect, it } from "vitest";
import {
  classifyStockSector,
  FMP_SECTOR_GICS,
} from "./stock-sector-classification.js";
import {
  FMP_STOCK_SECTORS,
  resolveStockSectorEtf,
} from "./stock-sector-etfs.js";

/** The alias table the product decision states, written out independently of the module. */
const EXPECTED: readonly (readonly [string, string])[] = [
  ["Technology", "INFORMATION_TECHNOLOGY"],
  ["Financial Services", "FINANCIALS"],
  ["Energy", "ENERGY"],
  ["Healthcare", "HEALTH_CARE"],
  ["Industrials", "INDUSTRIALS"],
  ["Consumer Cyclical", "CONSUMER_DISCRETIONARY"],
  ["Consumer Defensive", "CONSUMER_STAPLES"],
  ["Utilities", "UTILITIES"],
  ["Basic Materials", "MATERIALS"],
  ["Real Estate", "REAL_ESTATE"],
  ["Communication Services", "COMMUNICATION_SERVICES"],
];

describe("classifyStockSector", () => {
  it("maps each of FMP's eleven sectors to its own GICS sector", () => {
    expect(Object.keys(FMP_SECTOR_GICS).sort()).toEqual(
      [...FMP_STOCK_SECTORS].sort(),
    );
    expect(Object.entries(FMP_SECTOR_GICS)).toEqual(
      expect.arrayContaining(EXPECTED.map(([fmp, gics]) => [fmp, gics])),
    );
    const codes = Object.values(FMP_SECTOR_GICS);
    expect(new Set(codes).size).toBe(11);
    for (const [fmp, gics] of EXPECTED) {
      expect(classifyStockSector(fmp)).toEqual({
        status: "CLASSIFIED",
        fmpSector: fmp,
        gicsSector: gics,
      });
    }
  });

  it("tolerates case and whitespace exactly as the sector ETF resolver does", () => {
    expect(classifyStockSector("  consumer   CYCLICAL ")).toMatchObject({
      status: "CLASSIFIED",
      fmpSector: "Consumer Cyclical",
      gicsSector: "CONSUMER_DISCRETIONARY",
    });
  });

  it("reports a missing sector as unclassified, never guessed", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(classifyStockSector(value)).toEqual({
        status: "UNCLASSIFIED",
        reason: "MISSING",
        stored: null,
      });
    }
  });

  it("reports an unknown value as unsupported, kept as stored", () => {
    expect(classifyStockSector(" Conglomerates ")).toEqual({
      status: "UNCLASSIFIED",
      reason: "UNSUPPORTED",
      stored: "Conglomerates",
    });
  });

  it("recognizes exactly the strings the sector ETF resolver recognizes", () => {
    for (const value of [
      ...FMP_STOCK_SECTORS,
      "Health Care",
      "Financial",
      "Information Technology",
      "technology ",
      null,
    ]) {
      expect(classifyStockSector(value).status === "CLASSIFIED").toBe(
        resolveStockSectorEtf(value).status === "RESOLVED",
      );
    }
  });
});
