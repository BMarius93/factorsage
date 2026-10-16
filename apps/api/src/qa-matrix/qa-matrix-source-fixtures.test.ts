import {
  collectStrategyEtfSources,
  normalizeStrategyDefinition,
  STRATEGY_ETF_SOURCES,
  STOCK_SECTOR_ETF_CODES,
  strategyReadsStockSector,
  validateStrategy,
  type StrategyCondition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import {
  currentAsOfDate,
  deriveStrategyBehaviours,
  isQaMatrixRun,
  QA_MATRIX_ALL_SECURITIES,
  QA_MATRIX_ETF_STRATEGIES,
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_LIST_IDS_BY_SET,
  QA_MATRIX_METAMORPHIC_PAIRS,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_SECTOR_SECURITIES,
  QA_MATRIX_SECTOR_STRATEGIES,
  QA_MATRIX_SECURITIES,
  QA_MATRIX_STRATEGY_SET_LETTERS,
  qaMatrixCombinations,
  qaMatrixFixtures,
  STRUCTURAL_STRATEGY_BEHAVIOURS,
  type QaMatrixStrategyFixture,
} from "@intrinsic/testing";
import { eodCutoffDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  parseQaMatrixCaseId,
  qaMatrixCases,
  qaMatrixGoldenCases,
} from "./matrix-case";
import { metamorphicCasePairs } from "./matrix-source-coverage";

/**
 * The two data-source dimensions — static ETF Conditions (`E01` … `E10`) and Stock's Sector
 * (`T01` … `T10`) — held to the real Strategy contract, to their own coverage claims and to the
 * premises their metamorphic pairs rest on. Nothing here touches a database.
 */

/**
 * The sector each `L11` member is classified under, as the development catalog stored it on
 * 2026-10-15 (verified by the preflight's `etf-sources` check against the matrix database, which
 * fails a sweep whose catalog says otherwise).
 */
const L11_SECTORS: Readonly<Record<string, string>> = {
  AAPL: "Technology",
  JPM: "Financial Services",
  XOM: "Energy",
  JNJ: "Healthcare",
  CAT: "Industrials",
  HD: "Consumer Cyclical",
  KO: "Consumer Defensive",
  NEE: "Utilities",
  SHW: "Basic Materials",
  PLD: "Real Estate",
  GOOGL: "Communication Services",
};

const sourcedConditions = (
  definition: StrategyDefinition,
): StrategyCondition[] =>
  [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules ?? []).map((rule) => rule.signal),
  ].flatMap((signal) =>
    signal.conditions.filter(
      (condition) => "source" in condition.metric && condition.metric.source,
    ),
  );

const strip = (definition: StrategyDefinition): unknown =>
  JSON.parse(JSON.stringify(normalizeStrategyDefinition(definition)));

describe.each([
  ["ETF", "E", QA_MATRIX_ETF_STRATEGIES],
  ["SECTOR", "T", QA_MATRIX_SECTOR_STRATEGIES],
] as const)("the %s dimension", (set, letter, fixtures) => {
  it("is ten fixtures with their own letter, namespace and retention rule", () => {
    expect(QA_MATRIX_STRATEGY_SET_LETTERS[set]).toBe(letter);
    expect(fixtures).toHaveLength(QA_MATRIX_EXPECTED_STRATEGIES);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `${letter}${String(index + 1).padStart(2, "0")}`,
      ),
    );
    for (const fixture of fixtures) {
      expect(fixture.name).toMatch(
        new RegExp(`^${QA_MATRIX_NAME_PREFIX}${fixture.id}-[a-z0-9-]+$`),
      );
      expect(fixture.description.length).toBeGreaterThan(80);
      expect(
        isQaMatrixRun({
          strategyName: fixture.name,
          stockListName: `${QA_MATRIX_NAME_PREFIX}L11-x`,
        }),
      ).toBe(true);
    }
  });

  it("passes the real strategy contract and normalizes unchanged", () => {
    for (const fixture of fixtures) {
      expect(
        validateStrategy({
          name: fixture.name,
          description: fixture.description,
          definition: fixture.definition,
        }),
        fixture.id,
      ).toEqual([]);
      expect(strip(fixture.definition), fixture.id).toEqual(
        JSON.parse(JSON.stringify(fixture.definition)),
      );
    }
  });

  it("claims exactly the structural behaviours its definition contains", () => {
    const structural = new Set<string>(STRUCTURAL_STRATEGY_BEHAVIOURS);
    for (const fixture of fixtures) {
      expect(
        fixture.behaviours.filter((tag) => structural.has(tag)).sort(),
        fixture.id,
      ).toEqual([...deriveStrategyBehaviours(fixture.definition)].sort());
    }
  });

  it("never gives a Trigger a data source: ETF Triggers stay out of the product", () => {
    for (const fixture of fixtures) {
      const triggers = [
        ...fixture.definition.buyLevels.map((level) => level.signal.trigger),
        ...fixture.definition.sellLevels.map((level) => level.signal.trigger),
        ...(fixture.definition.finalExit?.rules ?? []).map(
          (rule) => rule.signal.trigger,
        ),
      ].filter((trigger) => trigger !== undefined);
      for (const trigger of triggers) {
        expect(
          "source" in trigger!.metric && trigger!.metric.source,
          fixture.id,
        ).toBeFalsy();
      }
    }
  });

  it("runs ten Lists and ten configurations: a thousand distinct cases", () => {
    const resolved = qaMatrixFixtures(currentAsOfDate(), undefined, fixtures);
    expect(resolved.lists.map((list) => list.id)).toEqual([
      ...QA_MATRIX_LIST_IDS_BY_SET[set],
    ]);
    const combinations = qaMatrixCombinations(resolved);
    expect(combinations).toHaveLength(QA_MATRIX_EXPECTED_COMBINATIONS);
    expect(new Set(combinations.map((entry) => entry.label)).size).toBe(
      QA_MATRIX_EXPECTED_COMBINATIONS,
    );
    const cases = qaMatrixCases(resolved);
    for (const matrixCase of cases.slice(0, 5)) {
      expect(parseQaMatrixCaseId(matrixCase.caseId)).toEqual({
        strategyId: matrixCase.strategyId,
        listId: matrixCase.listId,
        configId: matrixCase.configId,
      });
    }
    // The golden cells exist in this dimension, moved to its own tenth List where it differs.
    expect(qaMatrixGoldenCases(cases)).toHaveLength(6);
  });
});

describe("what the two dimensions read between them", () => {
  it("reads every one of the twenty ETFs, the eleven sector funds through L11", () => {
    const read = new Set<string>();
    for (const fixture of [
      ...QA_MATRIX_ETF_STRATEGIES,
      ...QA_MATRIX_SECTOR_STRATEGIES,
    ]) {
      for (const code of collectStrategyEtfSources(fixture.definition)) {
        read.add(code);
      }
    }
    expect(
      QA_MATRIX_SECTOR_STRATEGIES.some((fixture) =>
        strategyReadsStockSector(fixture.definition),
      ),
    ).toBe(true);
    for (const sector of Object.values(L11_SECTORS)) {
      read.add(
        STOCK_SECTOR_ETF_CODES[sector as keyof typeof STOCK_SECTOR_ETF_CODES],
      );
    }
    expect([...read].sort()).toEqual(
      STRATEGY_ETF_SOURCES.map((source) => source.code).sort(),
    );
  });

  it("gives L11 one member of each of FMP's eleven sectors, and only the Stock's Sector dimension runs it", () => {
    const sectors = qaMatrixFixtures(
      currentAsOfDate(),
      undefined,
      QA_MATRIX_SECTOR_STRATEGIES,
    ).lists.find((list) => list.id === "L11")!;
    expect(sectors.members.map((member) => member.symbol).sort()).toEqual(
      Object.keys(L11_SECTORS).sort(),
    );
    expect(new Set(Object.values(L11_SECTORS)).size).toBe(11);
    for (const set of ["CORE", "AUDIT", "FUNDAMENTALS", "ETF"] as const) {
      expect(QA_MATRIX_LIST_IDS_BY_SET[set]).not.toContain("L11");
    }
  });

  it("keeps the two sector-only securities out of the recorded universe the other dimensions derive L08 from", () => {
    const original = new Set<string>(
      QA_MATRIX_SECURITIES.map((security) => security.symbol),
    );
    for (const security of QA_MATRIX_SECTOR_SECURITIES) {
      expect(original.has(security.symbol)).toBe(false);
    }
    expect(QA_MATRIX_SECURITIES).toHaveLength(33);
    expect(QA_MATRIX_ALL_SECURITIES).toHaveLength(35);
    const l08 = qaMatrixFixtures(currentAsOfDate()).lists.find(
      (list) => list.id === "L08",
    )!;
    expect(l08.members).toHaveLength(30);
  });

  it("covers every technical metric family and every RSI and RVOL period through a source", () => {
    const fields = new Set<string>();
    for (const fixture of [
      ...QA_MATRIX_ETF_STRATEGIES,
      ...QA_MATRIX_SECTOR_STRATEGIES,
    ]) {
      for (const condition of sourcedConditions(fixture.definition)) {
        const metric = condition.metric;
        if (metric.kind === "PRICE") fields.add("PRICE");
        if (metric.kind === "MOVING_AVERAGE" || metric.kind === "OSCILLATOR")
          fields.add(metric.seriesId);
        if (metric.kind === "RELATIVE_VOLUME")
          fields.add(`RVOL_${metric.period}`);
        if (condition.value.kind === "SERIES")
          fields.add(condition.value.seriesId);
        fields.add(`OP:${condition.operator}`);
      }
    }
    for (const required of [
      "PRICE",
      "RSI_7D",
      "RSI_14D",
      "RSI_21D",
      "RVOL_10",
      "RVOL_20",
      "RVOL_50",
      "SMA_50D",
      "SMA_200D",
      "EMA_50D",
      "EMA_200D",
      "SMA_20W",
      "SMA_50W",
      "EMA_20W",
      "OP:IS_ABOVE",
      "OP:IS_BELOW",
      "OP:IS_CLOSE_TO",
    ]) {
      expect(fields.has(required), required).toBe(true);
    }
  });
});

describe("the metamorphic pairs' premises", () => {
  const byId = new Map<string, QaMatrixStrategyFixture>(
    [...QA_MATRIX_ETF_STRATEGIES, ...QA_MATRIX_SECTOR_STRATEGIES].map(
      (fixture) => [fixture.id, fixture],
    ),
  );

  it("E08 is E07 with one always-TRUE ETF Condition added to every level and nothing else", () => {
    const control = byId.get("E07")!.definition;
    const probe = byId.get("E08")!.definition;
    const withoutProbe = JSON.parse(
      JSON.stringify(probe),
    ) as StrategyDefinition;
    for (const signal of [
      ...withoutProbe.buyLevels.map((level) => level.signal),
      ...withoutProbe.sellLevels.map((level) => level.signal),
      ...(withoutProbe.finalExit?.rules ?? []).map((rule) => rule.signal),
    ]) {
      const added = signal.conditions.pop()!;
      expect(added.metric).toEqual({
        kind: "RELATIVE_VOLUME",
        period: 10,
        source: { kind: "ETF", code: "SP500" },
      });
      expect([added.operator, added.value]).toEqual([
        "IS_ABOVE",
        { kind: "MULTIPLE", value: 0 },
      ]);
    }
    expect(withoutProbe).toEqual(control);
  });

  it("E10 is E09 plus one BUY level gated by a never-TRUE ETF Condition, ids unchanged", () => {
    const control = byId.get("E09")!.definition;
    const probe = byId.get("E10")!.definition;
    expect(probe.buyLevels.slice(0, -1)).toEqual(control.buyLevels);
    expect(probe.sellLevels).toEqual(control.sellLevels);
    expect(probe.finalExit).toEqual(control.finalExit);
    const extra = probe.buyLevels.at(-1)!;
    expect(
      extra.signal.conditions.some(
        (condition) =>
          condition.metric.kind === "OSCILLATOR" &&
          "source" in condition.metric &&
          condition.metric.source?.kind === "ETF" &&
          condition.operator === "IS_ABOVE" &&
          condition.value.kind === "NUMBER" &&
          condition.value.value >= 100,
      ),
    ).toBe(true);
  });

  it("T10 is T09 reading Stock's Sector instead of XLK, ids unchanged", () => {
    const control = JSON.stringify(byId.get("T09")!.definition);
    const probe = JSON.stringify(byId.get("T10")!.definition);
    expect(
      probe.replaceAll(
        '{"kind":"STOCK_SECTOR"}',
        '{"kind":"ETF","code":"ETF_XLK"}',
      ),
    ).toBe(control);
    expect(L11_SECTORS.AAPL).toBe("Technology");
  });

  it("enumerates 200 static-ETF comparisons and 10 sector ones", () => {
    const etf = qaMatrixFixtures(
      currentAsOfDate(),
      undefined,
      QA_MATRIX_ETF_STRATEGIES,
    );
    const sector = qaMatrixFixtures(
      currentAsOfDate(),
      undefined,
      QA_MATRIX_SECTOR_STRATEGIES,
    );
    expect(metamorphicCasePairs("ETF", etf)).toHaveLength(200);
    const sectorPairs = metamorphicCasePairs("SECTOR", sector);
    expect(sectorPairs).toHaveLength(10);
    expect(
      sectorPairs.every((pair) => pair.control.startsWith("T09-L01-")),
    ).toBe(true);
    expect(
      metamorphicCasePairs("CORE", qaMatrixFixtures(currentAsOfDate())),
    ).toEqual([]);
    expect(
      QA_MATRIX_METAMORPHIC_PAIRS.map(
        (pair) => `${pair.control}≡${pair.probe}`,
      ),
    ).toEqual(["E07≡E08", "E09≡E10", "T09≡T10"]);
  });
});

describe("the matrix clock", () => {
  it("is the EOD cutoff the product measures every horizon from, not the UTC day", () => {
    const delay = 30 * 60_000;
    // 01:00 UTC on Friday 2026-10-16 is still Thursday evening in New York: the newest final
    // session is the 15th, while the UTC calendar already says the 16th.
    const lateEvening = new Date("2026-10-16T01:00:00.000Z");
    expect(currentAsOfDate(lateEvening, delay)).toBe("2026-10-15");
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-10-16");
    // 18:00 UTC on the 16th is 14:00 in New York: the 16th's session is still trading.
    expect(currentAsOfDate(new Date("2026-10-16T18:00:00.000Z"), delay)).toBe(
      "2026-10-15",
    );
    // And once its close plus the delay has passed, it is the 16th.
    expect(currentAsOfDate(new Date("2026-10-16T21:00:00.000Z"), delay)).toBe(
      "2026-10-16",
    );
    for (const instant of [
      "2026-03-08T07:30:00.000Z",
      "2026-11-01T05:00:00.000Z",
    ]) {
      expect(currentAsOfDate(new Date(instant), delay)).toBe(
        eodCutoffDate(new Date(instant), delay),
      );
    }
  });
});
