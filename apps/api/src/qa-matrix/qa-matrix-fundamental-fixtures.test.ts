import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategySignalFingerprint,
  validateStrategy,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import {
  FUNDAMENTAL_AUDIT_DRIFT_MESSAGE,
  FUNDAMENTAL_AUDIT_METRICS,
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_FUNDAMENTAL_STRATEGIES,
  QA_MATRIX_FUNDAMENTAL_STRATEGY_IDS,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_STRATEGIES,
  QA_MATRIX_STRATEGY_BEHAVIOURS,
  QA_MATRIX_STRATEGY_SET_LETTERS,
  QA_MATRIX_STRATEGY_SETS,
  STRUCTURAL_STRATEGY_BEHAVIOURS,
  currentAsOfDate,
  deriveStrategyBehaviours,
  isQaMatrixRun,
  qaMatrixCombinations,
  qaMatrixFixtures,
} from "@intrinsic/testing";
import {
  collectOperands,
  operandFundamentalMetricId,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  parseQaMatrixCaseId,
  qaMatrixCases,
  qaMatrixGoldenCases,
} from "./matrix-case";

/**
 * The Fundamentals strategy dimension — `F01` … `F10` — against the real product contracts.
 *
 * What this suite guarantees about the QA tooling rather than about any one run:
 *
 * 1. **The family is first-class.** `--strategies fundamentals` selects a 1,000-case dimension whose
 *    case ids, run labels and retention namespace are its own, and the tooling's structural tags know
 *    a Fundamental Condition by its unit instead of ignoring it.
 * 2. **No metric is silently absent.** Every one of the fifteen identities is named by at least one
 *    fixture and projected as its own `fundamental:<id>` column, so an archived sweep carries every
 *    column for the frame-provenance audit. The list compared against is the audit's own statement of
 *    the fifteen (`FUNDAMENTAL_AUDIT_METRICS`), not the product catalog, so a sixteenth metric added to
 *    the catalog alone fails here by name.
 * 3. **The representative cases exist**: percentage points, a raw multiple, a negative and a zero
 *    threshold, several Fundamentals ANDed, a Fundamental ANDed with technicals, Relative Volume and
 *    Margin of Safety, a Fundamental beside a technical Trigger, SELL and FINAL EXIT use, and the
 *    NOT_EVALUABLE probe.
 */

function signalsOf(definition: StrategyDefinition): StrategySignal[] {
  return [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules ?? []).map((rule) => rule.signal),
  ];
}

function fundamentalIdsOf(definition: StrategyDefinition): string[] {
  return collectOperands(definition)
    .map((key) => operandFundamentalMetricId(key))
    .filter((id): id is NonNullable<typeof id> => id !== null);
}

describe("QA-MATRIX Fundamentals strategy fixtures", () => {
  it("is a third strategy dimension with its own letter, namespace and retention rule", () => {
    expect(QA_MATRIX_STRATEGY_SETS).toEqual(["CORE", "AUDIT", "FUNDAMENTALS"]);
    expect(QA_MATRIX_STRATEGY_SET_LETTERS.FUNDAMENTALS).toBe("F");
    expect(QA_MATRIX_FUNDAMENTAL_STRATEGIES).toHaveLength(
      QA_MATRIX_EXPECTED_STRATEGIES,
    );
    expect(QA_MATRIX_FUNDAMENTAL_STRATEGY_IDS).toEqual(
      Array.from(
        { length: 10 },
        (_unused, index) => `F${String(index + 1).padStart(2, "0")}`,
      ),
    );
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      expect(fixture.name.startsWith(`${QA_MATRIX_NAME_PREFIX}F`)).toBe(true);
      expect(fixture.description.length).toBeGreaterThan(80);
      expect(
        isQaMatrixRun({
          strategyName: fixture.name,
          stockListName: `${QA_MATRIX_NAME_PREFIX}L01-single`,
        }),
      ).toBe(true);
    }
  });

  it("passes the real strategy validation contract and normalizes unchanged", () => {
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      const issues = validateStrategy({
        name: fixture.name,
        description: fixture.description,
        definition: fixture.definition,
      });
      expect(issues, `${fixture.name}: ${JSON.stringify(issues)}`).toEqual([]);
      expect(normalizeStrategyDefinition(fixture.definition)).toEqual(
        fixture.definition,
      );
    }
  });

  it("names every one of the fifteen Fundamental Metrics, and no identity the audit does not know", () => {
    const named = new Set(
      QA_MATRIX_FUNDAMENTAL_STRATEGIES.flatMap((fixture) =>
        fundamentalIdsOf(fixture.definition),
      ),
    );
    const audited = FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id);
    for (const id of named) {
      expect(audited, `${id}: ${FUNDAMENTAL_AUDIT_DRIFT_MESSAGE}`).toContain(
        id,
      );
    }
    expect(
      audited.filter((id) => !named.has(id)),
      "every audited metric must be exercised by the Fundamentals dimension",
    ).toEqual([]);
  });

  it("claims exactly the structural behaviours its definitions contain, Fundamentals by unit", () => {
    const structural = new Set<string>(STRUCTURAL_STRATEGY_BEHAVIOURS);
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      const derived = [...deriveStrategyBehaviours(fixture.definition)].sort();
      const claimed = fixture.behaviours
        .filter((tag) => structural.has(tag))
        .sort();
      expect(claimed, fixture.name).toEqual(derived);
    }
    // The tag follows the audit's own unit table, not the fixture author's word.
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const tags = deriveStrategyBehaviours({
        schemaVersion: 2,
        buyLevels: [
          {
            id: "b",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c",
                  metric: { kind: "FUNDAMENTAL", metricId: metric.id as never },
                  operator: "IS_ABOVE",
                  value: { kind: metric.unit, value: 1 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      });
      expect(tags.has(`FUNDAMENTAL_${metric.unit}`), metric.id).toBe(true);
    }
    // An identity the catalog does not define is refused by the tooling rather than left untagged.
    expect(() =>
      deriveStrategyBehaviours({
        schemaVersion: 2,
        buyLevels: [
          {
            id: "b",
            percentage: 100,
            signal: {
              conditions: [
                {
                  id: "c",
                  metric: { kind: "FUNDAMENTAL", metricId: "ROIC" as never },
                  operator: "IS_ABOVE",
                  value: { kind: "PERCENT", value: 1 },
                },
              ],
            },
          },
        ],
        sellLevels: [],
      }),
    ).toThrow(/does not recognise fundamental metric ROIC/);
  });

  it("covers every intended behaviour across the core and Fundamentals dimensions, the core set unchanged", () => {
    const fundamentalTags = new Set([
      "FUNDAMENTAL_PERCENT",
      "FUNDAMENTAL_MULTIPLE",
    ]);
    const core = new Set(
      QA_MATRIX_STRATEGIES.flatMap((fixture) => fixture.behaviours),
    );
    const fundamentals = new Set(
      QA_MATRIX_FUNDAMENTAL_STRATEGIES.flatMap((fixture) => fixture.behaviours),
    );
    for (const behaviour of QA_MATRIX_STRATEGY_BEHAVIOURS) {
      if (fundamentalTags.has(behaviour)) {
        // The core baseline predates the family and must not be edited to reach it.
        expect(core.has(behaviour), behaviour).toBe(false);
        expect(fundamentals.has(behaviour), behaviour).toBe(true);
      }
    }
  });

  it("contains the representative cases the coverage model promises", () => {
    const byId = new Map(
      QA_MATRIX_FUNDAMENTAL_STRATEGIES.map((fixture) => [fixture.id, fixture]),
    );
    const conditions = (id: string) =>
      signalsOf(byId.get(id)!.definition).flatMap(
        (signal) => signal.conditions,
      );
    const kinds = (id: string) =>
      new Set(conditions(id).map((c) => c.metric.kind));

    // Percentage points and a raw multiple, each alone.
    expect(fundamentalIdsOf(byId.get("F01")!.definition)).toEqual(["ROIC_TTM"]);
    expect(kinds("F02")).toEqual(new Set(["FUNDAMENTAL"]));
    // A negative threshold on a signed multiple and a zero threshold on a growth rate.
    expect(
      conditions("F06").some(
        (c) =>
          c.metric.kind === "FUNDAMENTAL" &&
          c.metric.metricId === "NET_DEBT_TO_EBITDA_TTM" &&
          c.operator === "IS_BELOW" &&
          c.value.kind === "MULTIPLE" &&
          c.value.value === 0,
      ),
    ).toBe(true);
    expect(
      conditions("F03").some(
        (c) =>
          c.metric.kind === "FUNDAMENTAL" &&
          c.operator === "IS_BELOW" &&
          c.value.kind === "PERCENT" &&
          c.value.value === 0,
      ),
    ).toBe(true);
    // Several Fundamentals ANDed in one Signal.
    expect(
      signalsOf(byId.get("F04")!.definition)[0]!.conditions.filter(
        (c) => c.metric.kind === "FUNDAMENTAL",
      ),
    ).toHaveLength(4);
    // A Fundamental ANDed with technicals, with Relative Volume and with Margin of Safety.
    expect(kinds("F07")).toEqual(
      new Set(["FUNDAMENTAL", "PRICE", "OSCILLATOR"]),
    );
    expect(kinds("F09")).toContain("RELATIVE_VOLUME");
    expect(kinds("F08")).toContain("MARGIN_OF_SAFETY");
    // A Fundamental Condition beside a technical Trigger; never a Fundamental Trigger.
    const f09Trigger = byId.get("F09")!.definition.buyLevels[0]!.signal.trigger;
    expect(f09Trigger?.metric.kind).toBe("PRICE");
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      for (const signal of signalsOf(fixture.definition)) {
        expect(signal.trigger?.metric.kind).not.toBe("FUNDAMENTAL");
      }
    }
    // SELL and FINAL EXIT use, including a two-rule FINAL EXIT made of Fundamentals.
    expect(
      byId.get("F02")!.definition.sellLevels[0]!.signal.conditions[0]!.metric
        .kind,
    ).toBe("FUNDAMENTAL");
    expect(byId.get("F06")!.definition.finalExit?.rules).toHaveLength(2);
    // The NOT_EVALUABLE probe: four Fundamentals that are rarely all decidable at once.
    expect(fundamentalIdsOf(byId.get("F10")!.definition)).toHaveLength(4);
  });

  it("never collapses two fixtures, or two levels of one fixture, into one fingerprint", () => {
    const definitions = QA_MATRIX_FUNDAMENTAL_STRATEGIES.map((fixture) =>
      strategyDefinitionFingerprint(fixture.definition),
    );
    expect(new Set(definitions).size).toBe(10);
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      const levels = signalsOf(fixture.definition).map((signal) =>
        strategySignalFingerprint(signal),
      );
      expect(new Set(levels).size, fixture.name).toBe(levels.length);
    }
  });

  it("enumerates 1,000 Fxx cases whose ids parse, and a golden set re-lettered onto the dimension", () => {
    const fixtures = qaMatrixFixtures(
      currentAsOfDate(),
      undefined,
      QA_MATRIX_FUNDAMENTAL_STRATEGIES,
    );
    expect(qaMatrixCombinations(fixtures)).toHaveLength(
      QA_MATRIX_EXPECTED_COMBINATIONS,
    );
    const cases = qaMatrixCases(fixtures);
    expect(cases).toHaveLength(QA_MATRIX_EXPECTED_COMBINATIONS);
    for (const entry of cases) {
      expect(entry.caseId).toMatch(/^F\d{2}-L\d{2}-C\d{2}$/);
      expect(parseQaMatrixCaseId(entry.caseId)).toMatchObject({
        strategyId: entry.strategyId,
      });
    }
    const golden = qaMatrixGoldenCases(cases);
    expect(golden.length).toBeGreaterThan(0);
    expect(golden.every((entry) => entry.strategyId.startsWith("F"))).toBe(
      true,
    );
    expect(parseQaMatrixCaseId("QA-MATRIX-F07-L03-C02")).toMatchObject({
      strategyId: "F07",
      listId: "L03",
      configId: "C02",
    });
  });
});
