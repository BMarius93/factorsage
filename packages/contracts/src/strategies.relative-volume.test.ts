import { describe, expect, it } from "vitest";
import {
  checkStrategyValue,
  conditionOperatorsFor,
  DEFAULT_RELATIVE_VOLUME_PERIOD,
  defaultConditionOperatorFor,
  defaultValueFor,
  describeCondition,
  normalizeStrategyDefinition,
  RELATIVE_VOLUME_PERIODS,
  relativeVolumeLabel,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_METRIC_DEFINITIONS,
  STRATEGY_SCHEMA_VERSION,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategyValueLabel,
  triggerOperatorsFor,
  validateStrategyDefinition,
  valueSpecFor,
  type RelativeVolumePeriod,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValidationIssue,
} from "./strategies.js";

function rvol(period: RelativeVolumePeriod): StrategyMetric {
  return { kind: "RELATIVE_VOLUME", period };
}

function multiple(value: number) {
  return { kind: "MULTIPLE", value } as const;
}

function definitionOf(
  buySignal: StrategySignal,
  extra: Partial<StrategyDefinition> = {},
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", signal: buySignal, percentage: 25 }],
    sellLevels: [],
    ...extra,
  };
}

function codesOf(issues: readonly StrategyValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

/** The RVOL condition the examples in the product brief are written as. */
function rvolCondition(
  period: RelativeVolumePeriod,
  operator: StrategyCondition["operator"],
  value: number,
  id = "condition-1",
): StrategyCondition {
  return { id, metric: rvol(period), operator, value: multiple(value) };
}

describe("Relative Volume as a Strategy metric", () => {
  it("offers exactly the three fixed periods, and no other window", () => {
    expect(RELATIVE_VOLUME_PERIODS).toEqual([10, 20, 50]);

    const offered = strategyMetricOptions("BUY")
      .filter((option) => option.metric.kind === "RELATIVE_VOLUME")
      .map((option) =>
        option.metric.kind === "RELATIVE_VOLUME" ? option.metric.period : null,
      );
    expect(offered).toEqual([10, 20, 50]);
  });

  it("refuses a period the product does not materialize", () => {
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [
          {
            id: "condition-1",
            metric: { kind: "RELATIVE_VOLUME", period: 30 },
            operator: "IS_ABOVE",
            value: multiple(2),
          } as unknown as StrategyCondition,
        ],
      }),
    );

    expect(codesOf(issues)).toEqual(["METRIC_PERIOD_UNSUPPORTED"]);
  });

  it("defaults a freshly selected metric to the 20-session window at 1.0x", () => {
    expect(DEFAULT_RELATIVE_VOLUME_PERIOD).toBe(20);
    // 1.0x is the neutral point of the unit: a session trading exactly its own baseline.
    expect(defaultValueFor(rvol(DEFAULT_RELATIVE_VOLUME_PERIOD))).toEqual(
      multiple(1),
    );
    expect(defaultConditionOperatorFor(rvol(20))).toBe("IS_ABOVE");
  });

  it("gives each period one product label, keyed distinctly for the select", () => {
    expect(strategyMetricLabel(rvol(20))).toBe("RVOL 20");
    expect(relativeVolumeLabel(50)).toBe("RVOL 50");
    const keys = RELATIVE_VOLUME_PERIODS.map((period) =>
      strategyMetricKey(rvol(period)),
    );
    // Three periods, three options: a key built from a catalog series id alone would collapse them.
    expect(new Set(keys).size).toBe(RELATIVE_VOLUME_PERIODS.length);
  });

  it("is compared with a multiple, displayed with its unit", () => {
    expect(valueSpecFor(rvol(20))).toEqual({
      kind: "MULTIPLE",
      min: 0,
      step: 0.1,
    });
    expect(strategyValueLabel(multiple(2))).toBe("2.0x");
    expect(strategyValueLabel(multiple(1.5))).toBe("1.5x");
    expect(strategyValueLabel(multiple(0.5))).toBe("0.5x");
  });

  it("rejects a value that is not a multiple, or is below zero", () => {
    expect(checkStrategyValue(rvol(20), { kind: "NUMBER", value: 2 })).toEqual({
      compatible: false,
      code: "VALUE_KIND_MISMATCH",
      message: expect.stringContaining("multiple"),
    });
    expect(checkStrategyValue(rvol(20), multiple(-1)).compatible).toBe(false);
    // No upper bound: a news-day RVOL of 30 is a real reading, not a typo.
    expect(checkStrategyValue(rvol(20), multiple(30))).toEqual({
      compatible: true,
    });
  });

  it("reads the product's worked examples back as written", () => {
    expect(describeCondition(rvolCondition(20, "IS_ABOVE", 2))).toBe(
      "RVOL 20 is above 2.0x",
    );
    expect(describeCondition(rvolCondition(10, "IS_ABOVE", 1.5))).toBe(
      "RVOL 10 is above 1.5x",
    );
    expect(describeCondition(rvolCondition(50, "IS_BELOW", 0.5))).toBe(
      "RVOL 50 is below 0.5x",
    );
  });

  it("is available as a Condition in every level kind", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      expect(
        strategyMetricOptions(levelKind, "CONDITION").some(
          (option) => option.metric.kind === "RELATIVE_VOLUME",
        ),
      ).toBe(true);
    }
    expect(
      validateStrategyDefinition(
        saveableWith(rvolCondition(20, "IS_ABOVE", 2)),
      ),
    ).toEqual([]);
  });

  it("survives canonicalization unchanged", () => {
    const definition = saveableWith(rvolCondition(20, "IS_ABOVE", 2));
    const normalized = normalizeStrategyDefinition(definition);

    expect(normalized.buyLevels[0]?.signal.conditions[0]).toEqual({
      id: "condition-1",
      metric: { kind: "RELATIVE_VOLUME", period: 20 },
      operator: "IS_ABOVE",
      value: { kind: "MULTIPLE", value: 2 },
    });
    // Idempotent: a saved definition read back and re-canonicalized is the same document.
    expect(normalizeStrategyDefinition(normalized)).toEqual(normalized);
  });
});

describe("Relative Volume is not a Trigger (regression)", () => {
  it("declares no trigger operators", () => {
    expect(
      STRATEGY_METRIC_DEFINITIONS.RELATIVE_VOLUME.triggerOperators,
    ).toEqual([]);
    expect(triggerOperatorsFor(rvol(20))).toEqual([]);
    // It is still a perfectly ordinary Condition metric.
    expect(conditionOperatorsFor(rvol(20))).toEqual(["IS_ABOVE", "IS_BELOW"]);
  });

  it("is never offered in a Trigger row, in any level kind", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      const triggerOptions = strategyMetricOptions(levelKind, "TRIGGER");
      expect(triggerOptions.length).toBeGreaterThan(0);
      expect(
        triggerOptions.some(
          (option) => option.metric.kind === "RELATIVE_VOLUME",
        ),
      ).toBe(false);
      // …while the same level's Condition list does offer it, so this is a part rule and not a
      // level rule that happens to hide it everywhere.
      expect(
        strategyMetricOptions(levelKind, "CONDITION").some(
          (option) => option.metric.kind === "RELATIVE_VOLUME",
        ),
      ).toBe(true);
    }
  });

  it("defaults to the Condition list when no part is named", () => {
    // The existing callers pass no part, and a Condition is what a bare metric list means.
    expect(strategyMetricOptions("BUY")).toEqual(
      strategyMetricOptions("BUY", "CONDITION"),
    );
  });

  it("is rejected by validation in a Trigger, in every level kind", () => {
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const operator of ["CROSSES_ABOVE", "CROSSES_BELOW"] as const) {
        const rvolTrigger = {
          id: "trigger-1",
          metric: rvol(20),
          operator,
          value: multiple(2),
        } as unknown as StrategyTrigger;

        const issues = validateStrategyDefinition(
          inLevel(levelKind, { conditions: [], trigger: rvolTrigger }),
        );

        expect(codesOf(issues)).toContain("METRIC_NOT_ALLOWED_IN_PART");
        // Reported against the metric, which is the field the user has to change.
        const issue = issues.find(
          (candidate) => candidate.code === "METRIC_NOT_ALLOWED_IN_PART",
        );
        expect(issue?.path.field).toBe("METRIC");
        expect(issue?.path.part).toBe("TRIGGER");
        expect(issue?.message).toContain("RVOL 20");
      }
    }
  });

  it("rejects it as a Trigger even under a condition operator", () => {
    // A document hand-written with `IS_ABOVE` in the trigger slot is refused for being the wrong
    // metric there, not merely for naming an operator a Trigger does not have.
    const issues = validateStrategyDefinition(
      inLevel("BUY", {
        conditions: [],
        trigger: {
          id: "trigger-1",
          metric: rvol(20),
          operator: "IS_ABOVE",
          value: multiple(2),
        } as unknown as StrategyTrigger,
      }),
    );

    expect(codesOf(issues)).toContain("METRIC_NOT_ALLOWED_IN_PART");
  });
});

/** A saveable strategy whose only BUY rule is `row`. */
function saveableWith(row: StrategyCondition): StrategyDefinition {
  return definitionOf({ conditions: [row] });
}

/** A saveable strategy carrying `levelSignal` in the given level kind. */
function inLevel(
  levelKind: StrategyLevelKind,
  levelSignal: StrategySignal,
): StrategyDefinition {
  if (levelKind === "BUY") {
    return definitionOf(levelSignal);
  }
  const base = definitionOf({
    conditions: [rvolCondition(20, "IS_ABOVE", 2, "buy-condition-1")],
  });
  return levelKind === "SELL"
    ? {
        ...base,
        sellLevels: [{ id: "sell-1", percentage: 25, signal: levelSignal }],
      }
    : {
        ...base,
        finalExit: {
          id: "exit-1",
          rules: [{ id: "exit-rule-1", signal: levelSignal }],
        },
      };
}
