import { describe, expect, it } from "vitest";
import {
  CATALOG_HISTORICAL_UNIVERSES,
  classificationOf,
  ECONOMIC_SUPERSECTORS,
  economicSupersectorOf,
  GICS_SECTOR_NAMES,
  GICS_SECTORS,
  HISTORICAL_UNIVERSE_CATEGORIES,
  HISTORICAL_UNIVERSE_LIST_ORDER_BASE,
  HISTORICAL_UNIVERSES,
  historicalUniverse,
  maintainedUniverseForList,
  publishedListFloor,
  RECONSTITUTION,
  RETROSPECTIVE_CLASSIFICATION_DISCLOSURE,
  rootIndexOf,
  unavailableRequirements,
} from "./historical-universes.js";
import { SP500_HISTORICAL_PIT_UNIVERSE } from "./market-index.js";

describe("historical universe catalog", () => {
  it("is the 26 agreed universes, by category", () => {
    const byCategory = (category: string) =>
      CATALOG_HISTORICAL_UNIVERSES.filter(
        (definition) => definition.category === category,
      ).map((definition) => definition.key);
    expect(CATALOG_HISTORICAL_UNIVERSES).toHaveLength(26);
    expect(byCategory("MARKET_INDICES")).toEqual([
      "sp500-historical-pit",
      "nasdaq100-historical-pit",
      "dow30-historical-pit",
    ]);
    expect(byCategory("SP500_SECTORS")).toHaveLength(11);
    expect(byCategory("ECONOMIC_SUPERSECTORS")).toEqual([
      "sp500-cyclical",
      "sp500-defensive",
      "sp500-sensitive",
    ]);
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

  it("keeps every published List's place: a category's order base never moves", () => {
    // The Lists published before the supersectors existed: 201, 301 and 401 stay where they are.
    expect(HISTORICAL_UNIVERSE_LIST_ORDER_BASE).toMatchObject({
      MARKET_INDICES: 0,
      MARKET_CAPITALIZATION: 200,
      INVESTMENT_STYLES: 300,
      DOW_STRATEGIES: 400,
    });
    const orders = CATALOG_HISTORICAL_UNIVERSES.map(
      (definition) =>
        HISTORICAL_UNIVERSE_LIST_ORDER_BASE[definition.category] +
        definition.displayOrder,
    );
    expect(new Set(orders).size).toBe(orders.length);
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
});

describe("economic supersectors", () => {
  it("assigns every GICS sector to exactly one supersector", () => {
    const assigned = Object.values(ECONOMIC_SUPERSECTORS).flat();
    expect([...assigned].sort()).toEqual([...GICS_SECTORS].sort());
    expect(new Set(assigned).size).toBe(GICS_SECTORS.length);
    for (const sector of GICS_SECTORS) {
      const owners = Object.entries(ECONOMIC_SUPERSECTORS).filter(
        ([, sectors]) => (sectors as readonly string[]).includes(sector),
      );
      expect(owners.map(([supersector]) => supersector)).toEqual([
        economicSupersectorOf(sector),
      ]);
    }
  });

  it("groups the agreed sectors", () => {
    expect(ECONOMIC_SUPERSECTORS).toEqual({
      CYCLICAL: [
        "FINANCIALS",
        "CONSUMER_DISCRETIONARY",
        "MATERIALS",
        "REAL_ESTATE",
      ],
      DEFENSIVE: ["CONSUMER_STAPLES", "HEALTH_CARE", "UTILITIES"],
      SENSITIVE: [
        "INFORMATION_TECHNOLOGY",
        "COMMUNICATION_SERVICES",
        "INDUSTRIALS",
        "ENERGY",
      ],
    });
  });

  it("draws the three from the S&P 500 by current sector, mutually exclusive", () => {
    const supersectors = CATALOG_HISTORICAL_UNIVERSES.filter(
      (definition) => definition.category === "ECONOMIC_SUPERSECTORS",
    );
    const claimed: string[] = [];
    for (const definition of supersectors) {
      expect(definition.audience).toBe("CATALOG");
      expect(rootIndexOf(definition)).toBe("SP500");
      expect(unavailableRequirements(definition)).toEqual([]);
      expect(definition.requires).toContain("CURRENT_SECTOR_CLASSIFICATION");
      expect(definition.requires).not.toContain(
        "HISTORICAL_SECTOR_CLASSIFICATION",
      );
      expect(definition.methodology).toMatch(/retrospective/i);
      expect(definition.methodology).toMatch(/not a licensed index/i);
      expect(definition.description).not.toMatch(/morningstar/i);
      const method = definition.method;
      if (method.kind !== "CLASSIFICATION") {
        throw new Error(`${definition.key} is not a classification universe`);
      }
      expect(method).toMatchObject({
        indexKey: "SP500",
        scheme: "CURRENT_SECTOR",
      });
      claimed.push(...method.sectors);
    }
    expect(claimed.sort()).toEqual([...GICS_SECTORS].sort());
  });

  it("flags the classification retrospective, and no point-in-time universe's", () => {
    const cyclical = historicalUniverse("sp500-cyclical")!;
    expect(classificationOf(cyclical)).toEqual({
      timing: "RETROSPECTIVE",
      scheme: "CURRENT_SECTOR",
      methodLabel: "Current sector applied retrospectively",
      underlyingIndex: "S&P 500",
      sectors: [
        "FINANCIALS",
        "CONSUMER_DISCRETIONARY",
        "MATERIALS",
        "REAL_ESTATE",
      ],
      sectorNames: [
        GICS_SECTOR_NAMES.FINANCIALS,
        "Consumer Discretionary",
        "Materials",
        "Real Estate",
      ],
      disclosure: RETROSPECTIVE_CLASSIFICATION_DISCLOSURE,
    });
    expect(maintainedUniverseForList("sp500-defensive")).toMatchObject({
      indexKey: "SP500",
      derived: true,
      category: "ECONOMIC_SUPERSECTORS",
      membershipFloor: "1996-01-02",
      classification: { timing: "RETROSPECTIVE" },
    });
    // Its List carries the disclosure wherever the List is shown, within a List description's 500.
    const defensive = maintainedUniverseForList("sp500-defensive")!;
    expect(defensive.listDescription).toContain(
      RETROSPECTIVE_CLASSIFICATION_DISCLOSURE,
    );
    for (const definition of CATALOG_HISTORICAL_UNIVERSES) {
      expect(
        maintainedUniverseForList(definition.key)!.listDescription.length,
      ).toBeLessThanOrEqual(500);
    }
    for (const key of [
      "sp500-historical-pit",
      "sp500-top100-market-cap",
      "dogs-of-the-dow",
      "sp500-sector-technology",
    ]) {
      expect(classificationOf(historicalUniverse(key)!)).toBeNull();
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
    // A retrospectively classified universe follows its index from the floor.
    expect(publishedListFloor("sp500-sensitive", "2016-01-30")).toBe(
      "1996-01-02",
    );
  });
});
