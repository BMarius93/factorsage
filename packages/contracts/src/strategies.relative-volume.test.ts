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
  strategyDefinitionFingerprint,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategySignalFingerprint,
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

describe("Relative Volume period is part of the semantic identity", () => {
  /**
   * The defect this suite pins.
   *
   * Relative Volume is parameterized by a period and by nothing else — it has no catalog id — so an
   * identity built from `kind` plus a series id collapsed all three periods into one string. Two
   * consequences followed: `RVOL 10 is above 2 AND RVOL 20 is above 2` was refused as a duplicate,
   * and two levels whose logic genuinely differed shared one `strategySignalFingerprint`, which is
   * the key `StrategyVersion.definitionHash` and `MonitorSignalState.signalFingerprint` are built
   * from.
   */
  it("gives each period its own signal fingerprint", () => {
    const fingerprints = RELATIVE_VOLUME_PERIODS.map((period) =>
      strategySignalFingerprint({
        conditions: [rvolCondition(period, "IS_ABOVE", 2)],
      }),
    );

    expect(new Set(fingerprints).size).toBe(RELATIVE_VOLUME_PERIODS.length);
    // Stated pairwise as well, because a set of three says nothing about which pair collided.
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(fingerprints[1]).not.toBe(fingerprints[2]);
    expect(fingerprints[0]).not.toBe(fingerprints[2]);
  });

  it("gives each period its own definition fingerprint", () => {
    const fingerprints = RELATIVE_VOLUME_PERIODS.map((period) =>
      strategyDefinitionFingerprint(
        saveableWith(rvolCondition(period, "IS_ABOVE", 2)),
      ),
    );

    expect(new Set(fingerprints).size).toBe(RELATIVE_VOLUME_PERIODS.length);
  });

  it("keeps the same period on the same fingerprint", () => {
    // The other half of the guarantee: the period participates, and nothing else about the row's
    // identity moved, so the same logic written twice still serializes once.
    expect(
      strategySignalFingerprint({
        conditions: [rvolCondition(20, "IS_ABOVE", 2, "condition-a")],
      }),
    ).toBe(
      strategySignalFingerprint({
        conditions: [rvolCondition(20, "IS_ABOVE", 2, "condition-b")],
      }),
    );
  });

  it("serializes the period as the metric's third element", () => {
    // Pinned byte-for-byte: this string is what a persisted `definitionHash` is a digest of, so it
    // may not drift silently. The period sits in the third slot, which only the metrics that are
    // *not* parameterized by a catalog id use.
    expect(
      strategyDefinitionFingerprint(
        saveableWith(rvolCondition(20, "IS_ABOVE", 2)),
      ),
    ).toBe(
      '[1,[[25,[[[["RELATIVE_VOLUME",null,20],"IS_ABOVE",["MULTIPLE",2]]],null]]],[],null]',
    );
  });

  it("leaves a definition without Relative Volume byte-identical", () => {
    // The backwards-compatibility guarantee: fixing RVOL may not move the stored hash, or the
    // Monitor latch, of a strategy that never mentioned it. This is the same pinned string
    // `strategies.alternative-data.test.ts` asserts, for the same reason.
    const definition: StrategyDefinition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "b1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
              {
                id: "c2",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
            ],
            trigger: {
              id: "t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
          },
        },
      ],
      sellLevels: [],
    };

    expect(strategyDefinitionFingerprint(definition)).toBe(
      '[1,[[50,[[[["PRICE",null],"IS_BELOW",["SERIES","SMA_200D"]],[["OSCILLATOR","RSI_14D"],"IS_BELOW",["NUMBER",30]]],[["PRICE",null],"CROSSES_ABOVE",["SERIES","EMA_50D"]]]]],[],null]',
    );
  });

  it("accepts two periods in one Signal", () => {
    // The reported rejection: both rows are `is above 2`, and before the fix the second was refused
    // as `DUPLICATE_CONDITION` because the identity dropped the period.
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [
          rvolCondition(10, "IS_ABOVE", 2, "condition-1"),
          rvolCondition(20, "IS_ABOVE", 2, "condition-2"),
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it("accepts all three periods in one Signal", () => {
    expect(
      validateStrategyDefinition(
        definitionOf({
          conditions: RELATIVE_VOLUME_PERIODS.map((period, index) =>
            rvolCondition(period, "IS_ABOVE", 2, `condition-${index + 1}`),
          ),
        }),
      ),
    ).toEqual([]);
  });

  it("still rejects the same period written twice", () => {
    const issues = validateStrategyDefinition(
      definitionOf({
        conditions: [
          rvolCondition(10, "IS_ABOVE", 2, "condition-1"),
          rvolCondition(10, "IS_ABOVE", 2, "condition-2"),
        ],
      }),
    );

    expect(codesOf(issues)).toContain("DUPLICATE_CONDITION");
    const issue = issues.find(
      (candidate) => candidate.code === "DUPLICATE_CONDITION",
    );
    // Reported against the repeat, not the row the user wrote first.
    expect(issue?.path.conditionIndex).toBe(1);
  });

  it("separates the periods in FINAL EXIT duplicate detection too", () => {
    const exitRule = (period: RelativeVolumePeriod, id: string) => ({
      id,
      signal: { conditions: [rvolCondition(period, "IS_ABOVE", 2, `${id}-c`)] },
    });
    const withRules = (rules: ReturnType<typeof exitRule>[]) =>
      validateStrategyDefinition(
        definitionOf(
          { conditions: [rvolCondition(20, "IS_ABOVE", 2, "buy-condition-1")] },
          { finalExit: { id: "exit-1", rules } },
        ),
      );

    expect(
      withRules([exitRule(10, "exit-rule-1"), exitRule(20, "exit-rule-2")]),
    ).toEqual([]);
    expect(
      codesOf(
        withRules([exitRule(10, "exit-rule-1"), exitRule(10, "exit-rule-2")]),
      ),
    ).toContain("DUPLICATE_EXIT_RULE");
  });

  it("round-trips every period through canonicalization", () => {
    for (const period of RELATIVE_VOLUME_PERIODS) {
      const definition = saveableWith(rvolCondition(period, "IS_ABOVE", 2));
      const normalized = normalizeStrategyDefinition(definition);

      expect(normalized.buyLevels[0]?.signal.conditions[0]?.metric).toEqual({
        kind: "RELATIVE_VOLUME",
        period,
      });
      // Canonicalizing a canonical document changes nothing, and neither does its fingerprint.
      expect(normalizeStrategyDefinition(normalized)).toEqual(normalized);
      expect(strategyDefinitionFingerprint(normalized)).toBe(
        strategyDefinitionFingerprint(definition),
      );
    }
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
