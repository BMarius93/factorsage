import { describe, expect, it } from "vitest";
import {
  CATALOG_HISTORICAL_UNIVERSES,
  HISTORICAL_UNIVERSE_CATEGORIES,
  HISTORICAL_UNIVERSES,
  historicalUniverse,
  maintainedUniverseForList,
  publishedListFloor,
  RECONSTITUTION,
  rootIndexOf,
  unavailableRequirements,
} from "./historical-universes.js";
import { SP500_HISTORICAL_PIT_UNIVERSE } from "./market-index.js";

describe("historical universe catalog", () => {
  it("is the 23 agreed universes, by category", () => {
    const byCategory = (category: string) =>
      CATALOG_HISTORICAL_UNIVERSES.filter(
        (definition) => definition.category === category,
      ).map((definition) => definition.key);
    expect(CATALOG_HISTORICAL_UNIVERSES).toHaveLength(23);
    expect(byCategory("MARKET_INDICES")).toEqual([
      "sp500-historical-pit",
      "nasdaq100-historical-pit",
      "dow30-historical-pit",
    ]);
    expect(byCategory("SP500_SECTORS")).toHaveLength(11);
    expect(byCategory("MARKET_CAPITALIZATION")).toEqual([
      "sp500-top100-market-cap",
      "sp500-top250-market-cap",
    ]);
    expect(byCategory("INVESTMENT_STYLES").sort()).toEqual(
      [
        "sp500-growth",
        "sp500-value",
        "sp500-high-dividend",
        "sp500-top50-momentum",
        "sp500-top100-liquidity",
      ].sort(),
    );
    expect(byCategory("DOW_STRATEGIES")).toEqual([
      "dogs-of-the-dow",
      "small-dogs-of-the-dow",
    ]);
    expect(byCategory("RESEARCH")).toEqual([]);
  });

  it("has unique keys, every one resolvable, and keeps research universes internal", () => {
    const keys = HISTORICAL_UNIVERSES.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const definition of HISTORICAL_UNIVERSES) {
      expect(historicalUniverse(definition.key)).toBe(definition);
      expect(HISTORICAL_UNIVERSE_CATEGORIES).toContain(definition.category);
      expect(definition.audience === "INTERNAL").toBe(
        definition.category === "RESEARCH",
      );
      expect(definition.methodology.length).toBeGreaterThan(40);
    }
    expect(
      HISTORICAL_UNIVERSES.filter(
        (definition) => definition.audience === "INTERNAL",
      ).length,
    ).toBeGreaterThan(20);
  });

  it("blocks every sector: no source provides a point-in-time classification", () => {
    for (const definition of CATALOG_HISTORICAL_UNIVERSES) {
      const blocked = unavailableRequirements(definition).length > 0;
      expect(blocked).toBe(definition.category === "SP500_SECTORS");
    }
  });

  it("draws each ranking from its root index, Small Dogs through the Dogs", () => {
    expect(rootIndexOf(historicalUniverse("small-dogs-of-the-dow")!)).toBe(
      "DOW30",
    );
    expect(rootIndexOf(historicalUniverse("sp500-top100-market-cap")!)).toBe(
      "SP500",
    );
    expect(rootIndexOf(historicalUniverse("nasdaq100-top25-market-cap")!)).toBe(
      "NASDAQ100",
    );
    const smallDogs = historicalUniverse("small-dogs-of-the-dow")!.method;
    expect(smallDogs).toMatchObject({
      kind: "RANK",
      parent: { kind: "UNIVERSE", key: "dogs-of-the-dow" },
      metric: "NOMINAL_PRICE",
      order: "LOWEST",
      select: { count: 5 },
      reconstitution: RECONSTITUTION.ANNUAL,
    });
    expect(historicalUniverse("dogs-of-the-dow")!.method).toMatchObject({
      parent: { kind: "INDEX", indexKey: "DOW30" },
      metric: "INDICATED_DIVIDEND_YIELD",
      select: { count: 10 },
    });
    expect(historicalUniverse("sp500-top50-momentum")!.method).toMatchObject({
      metric: "MOMENTUM_12_1",
      reconstitution: RECONSTITUTION.MONTHLY,
    });
    expect(historicalUniverse("sp500-top100-liquidity")!.method).toMatchObject({
      metric: "DOLLAR_VOLUME_63D",
      select: { count: 100 },
    });
  });

  it("recognizes a catalog universe's List, and never a research one's", () => {
    expect(maintainedUniverseForList("sp500-historical-pit")).toMatchObject({
      universeKey: "sp500-historical-pit",
      indexKey: "SP500",
      derived: false,
      // The S&P 500's List keeps the name and disclosure it was published with.
      listName: SP500_HISTORICAL_PIT_UNIVERSE.listName,
      listDescription: SP500_HISTORICAL_PIT_UNIVERSE.listDescription,
    });
    expect(maintainedUniverseForList("dogs-of-the-dow")).toMatchObject({
      indexKey: "DOW30",
      derived: true,
      category: "DOW_STRATEGIES",
    });
    expect(maintainedUniverseForList("sp500-top25-market-cap")).toBeNull();
    expect(maintainedUniverseForList("recent-market-debuts")).toBeNull();
    expect(maintainedUniverseForList(null)).toBeNull();
  });

  it("starts the S&P 500's List at its floor and every other at its reliable period", () => {
    expect(publishedListFloor("sp500-historical-pit", "2016-01-30")).toBe(
      "1996-01-02",
    );
    expect(publishedListFloor("nasdaq100-historical-pit", "2016-01-01")).toBe(
      "2016-01-01",
    );
    expect(publishedListFloor("dogs-of-the-dow", null)).toBeNull();
  });
});
