import {
  STRATEGY_SCHEMA_VERSION,
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  upgradeStrategyDefinitionDocument,
  validateStrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import { projectEvaluationFrame } from "@intrinsic/stock-data";
import {
  Evaluability,
  collectOperands,
  evaluateMarketCondition,
  fundamentalMetricOperand,
  operandFundamentalMetricId,
  readOperand,
} from "@intrinsic/strategy";
import {
  FUNDAMENTAL_AUDIT_METRICS,
  FUNDAMENTAL_AUDIT_METRIC_IDS,
  type FundamentalAuditMetric,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { corpusDigest, fingerprintCorpus } from "./fingerprint-corpus";

/**
 * Fundamental Metrics in the Strategy language, audited against the methodology's own table.
 *
 * Every identity, unit and storage field below comes from `FUNDAMENTAL_AUDIT_METRICS` — the ADR's
 * Scope table written down by hand — never from the product catalog or the domain registry, so a
 * mapping defect in either cannot agree with itself here.
 */

type Level = "BUY" | "SELL" | "FINAL_EXIT";
const LEVELS: readonly Level[] = ["BUY", "SELL", "FINAL_EXIT"];

const ANCHOR_CONDITION = {
  id: "anchor",
  metric: { kind: "PRICE" },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId: "SMA_200D" },
};

/** A raw, runtime-shaped definition carrying `signal` in `level`, as JSON would deliver it. */
function documentWith(level: Level, signal: unknown): unknown {
  const buySignal =
    level === "BUY" ? signal : { conditions: [ANCHOR_CONDITION] };
  return JSON.parse(
    JSON.stringify({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "buy-1", percentage: 50, signal: buySignal }],
      sellLevels:
        level === "SELL" ? [{ id: "sell-1", percentage: 50, signal }] : [],
      ...(level === "FINAL_EXIT"
        ? { finalExit: { id: "exit", rules: [{ id: "rule-1", signal }] } }
        : {}),
    }),
  );
}

function ownUnitValue(metric: FundamentalAuditMetric, value: number) {
  return { kind: metric.unit, value };
}

function otherUnitValue(metric: FundamentalAuditMetric, value: number) {
  return { kind: metric.unit === "PERCENT" ? "MULTIPLE" : "PERCENT", value };
}

function codes(document: unknown): string[] {
  return validateStrategyDefinition(document).map((issue) => issue.code);
}

describe("Fundamental Metric validation, every metric in every level (audit section 18)", () => {
  it("accepts is above and is below with the metric's own unit, in BUY, SELL and FINAL EXIT", () => {
    let accepted = 0;
    for (const level of LEVELS) {
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        for (const operator of ["IS_ABOVE", "IS_BELOW"]) {
          const document = documentWith(level, {
            conditions: [
              {
                id: "fundamental",
                metric: { kind: "FUNDAMENTAL", metricId: metric.id },
                operator,
                value: ownUnitValue(metric, 1),
              },
            ],
          });
          expect(codes(document), `${level} ${metric.id} ${operator}`).toEqual(
            [],
          );
          accepted += 1;
        }
      }
    }
    expect(accepted).toBe(3 * 15 * 2);
  });

  it("refuses is close to, every Trigger operator, and a Fundamental Trigger beside valid Conditions", () => {
    for (const level of LEVELS) {
      for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
        const fundamental = { kind: "FUNDAMENTAL", metricId: metric.id };
        expect(
          codes(
            documentWith(level, {
              conditions: [
                {
                  id: "close",
                  metric: fundamental,
                  operator: "IS_CLOSE_TO",
                  value: ownUnitValue(metric, 1),
                },
              ],
            }),
          ),
          `${level} ${metric.id} IS_CLOSE_TO`,
        ).toContain("OPERATOR_NOT_SUPPORTED");
        for (const operator of ["CROSSES_ABOVE", "CROSSES_BELOW", "IS_ABOVE"]) {
          const trigger = {
            id: "trigger",
            metric: fundamental,
            operator,
            value: ownUnitValue(metric, 1),
          };
          expect(
            codes(documentWith(level, { conditions: [], trigger })),
            `${level} ${metric.id} trigger ${operator}`,
          ).toContain("METRIC_NOT_ALLOWED_IN_PART");
          expect(
            codes(
              documentWith(level, {
                conditions: [
                  {
                    id: "ok",
                    metric: fundamental,
                    operator: "IS_ABOVE",
                    value: ownUnitValue(metric, 1),
                  },
                ],
                trigger,
              }),
            ),
            `${level} ${metric.id} condition + trigger ${operator}`,
          ).toContain("METRIC_NOT_ALLOWED_IN_PART");
        }
      }
    }
  });

  it("refuses the other unit and every non-unit Value kind", () => {
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      for (const value of [
        otherUnitValue(metric, 1),
        { kind: "NUMBER", value: 1 },
        { kind: "MONEY", value: 1 },
        { kind: "SERIES", seriesId: "SMA_50D" },
      ]) {
        const issues = codes(
          documentWith("BUY", {
            conditions: [
              {
                id: "fundamental",
                metric: { kind: "FUNDAMENTAL", metricId: metric.id },
                operator: "IS_ABOVE",
                value,
              },
            ],
          }),
        );
        expect(
          issues.length,
          `${metric.id} ${JSON.stringify(value)}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("refuses every malformed identity arriving as runtime JSON, and never a storage field or label", () => {
    const malformed: unknown[] = [
      ...FUNDAMENTAL_AUDIT_METRICS.flatMap((metric) => [
        metric.id.toLowerCase(),
        metric.field,
        ` ${metric.id}`,
        `${metric.id} `,
        `fundamental:${metric.id}`,
        metric.id.replaceAll("_", " "),
      ]),
      "",
      "ROIC",
      "ROIC_TTM_",
      null,
      15,
      true,
      {},
      ["ROIC_TTM"],
    ];
    for (const metricId of malformed) {
      const issues = codes(
        documentWith("BUY", {
          conditions: [
            {
              id: "fundamental",
              metric: { kind: "FUNDAMENTAL", metricId },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 1 },
            },
          ],
        }),
      );
      expect(issues, JSON.stringify(metricId)).toContain(
        "FUNDAMENTAL_METRIC_UNSUPPORTED",
      );
    }
    // A missing identity, and a label or field carried beside a valid one, are refused too.
    expect(
      codes(
        documentWith("BUY", {
          conditions: [
            {
              id: "fundamental",
              metric: { kind: "FUNDAMENTAL" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 1 },
            },
          ],
        }),
      ).length,
    ).toBeGreaterThan(0);
    for (const extra of [{ label: "ROIC TTM" }, { field: "roicTtm" }]) {
      expect(
        codes(
          documentWith("BUY", {
            conditions: [
              {
                id: "fundamental",
                metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM", ...extra },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 1 },
              },
            ],
          }),
        ).length,
        JSON.stringify(extra),
      ).toBeGreaterThan(0);
    }
  });
});

function signalOf(
  metricId: string,
  unit: string,
  value: number,
): StrategySignal {
  return {
    conditions: [
      {
        id: "only",
        metric: { kind: "FUNDAMENTAL", metricId } as never,
        operator: "IS_ABOVE",
        value: { kind: unit, value } as never,
      },
    ],
  };
}

describe("Fundamental Metric identity in the fingerprint (audit section 19)", () => {
  it("gives fifteen metrics fifteen fingerprints under one rule, in every level kind", () => {
    for (const level of LEVELS) {
      const fingerprints = FUNDAMENTAL_AUDIT_METRICS.map((metric) => {
        // One threshold for all fifteen: only the identity differs.
        const definition = normalizeStrategyDefinition(
          documentWith(level, signalOf(metric.id, metric.unit, 1)),
        );
        return strategyDefinitionFingerprint(definition);
      });
      expect(new Set(fingerprints).size, level).toBe(15);
    }
    const signals = FUNDAMENTAL_AUDIT_METRICS.map((metric) =>
      strategySignalFingerprint(signalOf(metric.id, "PERCENT", 1)),
    );
    expect(new Set(signals).size).toBe(15);
  });

  it("serializes the stable identity, byte for byte, and neither a label nor a storage field", () => {
    // Hand-written from the serialization: [[metric, operator, value]], trigger.
    expect(strategySignalFingerprint(signalOf("ROIC_TTM", "PERCENT", 15))).toBe(
      '[[[["FUNDAMENTAL",null,"ROIC_TTM"],"IS_ABOVE",["PERCENT",15]]],null]',
    );
    expect(
      strategySignalFingerprint(signalOf("DEBT_TO_EQUITY", "MULTIPLE", 1)),
    ).toBe(
      '[[[["FUNDAMENTAL",null,"DEBT_TO_EQUITY"],"IS_ABOVE",["MULTIPLE",1]]],null]',
    );
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const fingerprint = strategySignalFingerprint(
        signalOf(metric.id, metric.unit, 1),
      );
      expect(fingerprint).toContain(`"${metric.id}"`);
      expect(fingerprint).not.toContain(metric.field);
      expect(fingerprint).not.toContain(" ");
    }
  });

  it("survives serialization, reload, canonicalization and the version 1 upcast unchanged", () => {
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const document = documentWith(
        "FINAL_EXIT",
        signalOf(metric.id, metric.unit, 2.5),
      );
      const canonical = normalizeStrategyDefinition(document);
      const reloaded = normalizeStrategyDefinition(
        JSON.parse(JSON.stringify(canonical)),
      );
      expect(strategyDefinitionFingerprint(reloaded)).toBe(
        strategyDefinitionFingerprint(canonical),
      );
      // Version 1 carried FINAL EXIT as one flat signal; its upcast fingerprints identically.
      const versionOne = JSON.parse(JSON.stringify(document)) as Record<
        string,
        unknown
      >;
      versionOne.schemaVersion = 1;
      const exit = versionOne.finalExit as {
        id: string;
        rules: { signal: unknown }[];
      };
      versionOne.finalExit = { id: exit.id, signal: exit.rules[0]!.signal };
      const upcast = normalizeStrategyDefinition(
        upgradeStrategyDefinitionDocument(versionOne),
      );
      expect(strategyDefinitionFingerprint(upcast)).toBe(
        strategyDefinitionFingerprint(canonical),
      );
      expect(strategyFinalExitFingerprint(upcast.finalExit!)).toBe(
        strategySignalFingerprint(canonical.finalExit!.rules[0]!.signal),
      );
    }
  });

  it("leaves every pre-existing fingerprint byte-identical to main before the Strategy slice (e0045acd)", () => {
    const rows = fingerprintCorpus();
    const families: Record<string, typeof rows> = {};
    for (const row of rows) {
      (families[row.family] ??= []).push(row);
    }
    const byFamily = Object.fromEntries(
      Object.entries(families).map(([family, list]) => [
        family,
        { rows: list.length, digest: corpusDigest(list) },
      ]),
    );
    // Computed by running `fingerprint-corpus.ts`'s corpus against the contracts build of
    // `e0045acd` (main after #67, before #70 added the FUNDAMENTAL kind). Pinned, never recomputed.
    expect({
      rows: rows.length,
      overall: corpusDigest(rows),
      byFamily,
    }).toEqual({
      rows: 5760,
      overall:
        "b09d25a950d57e1e2a58952da8727fbfaf87f43a4009792d5adc67d8e95ce8f3",
      byFamily: {
        PRICE: {
          rows: 40,
          digest:
            "156352760d189a12870772a40fd62ffbae5c03e1c257c8ef0e6018a703990aad",
        },
        MOVING_AVERAGE: {
          rows: 560,
          digest:
            "70b3fe7b5da83d8803fae2cb7c33ed393620c87af57943a8bfa4e0e007109a46",
        },
        OSCILLATOR: {
          rows: 120,
          digest:
            "15043c8109bd6f045654e7885fc94da33235a2ddceca549ea0647e4f001d5dcd",
        },
        RELATIVE_VOLUME: {
          rows: 120,
          digest:
            "dd7f69d832154f8e5269adf42464b94f2efd53360ff566e35d9186eba8f99737",
        },
        MARGIN_OF_SAFETY: {
          rows: 280,
          digest:
            "c2461fe87312097418c3bf1fac8036c1da08536684e30f835d0aa9ddcf4d0524",
        },
        GAIN: {
          rows: 40,
          digest:
            "9d4bfa07810bdadea9f3c2ae69effa22705035b00d8494480499e91658e18a23",
        },
        LOSS: {
          rows: 40,
          digest:
            "203693f1e83ffa6c1c8b781233b7347fa9d67f8f2f4f1017ab345acc3058ca12",
        },
        INSIDER_ACTIVITY: {
          rows: 960,
          digest:
            "238a3862fcd03af5602ebf8a38ad5ab3375a7e8f45c3007f7968f561bc137078",
        },
        CONGRESS_ACTIVITY: {
          rows: 3600,
          digest:
            "69bd6588050faef1c95358cd1d3244774093bc4c2cddde37ffc8f8d375e43399",
        },
      },
    });
  });
});

describe("Fundamental operands (audit section 17)", () => {
  it("encodes each identity as its own key and decodes nothing else", () => {
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const key = fundamentalMetricOperand(metric.id as never);
      expect(key).toBe(`fundamental:${metric.id}`);
      expect(operandFundamentalMetricId(key)).toBe(metric.id);
      for (const alias of [
        `fundamental:${metric.id.toLowerCase()}`,
        `fundamental:${metric.field}`,
        `fundamentals:${metric.id}`,
        `series:${metric.id}`,
        metric.id,
        `fundamental: ${metric.id}`,
      ]) {
        expect(operandFundamentalMetricId(alias), alias).toBeNull();
      }
    }
    expect(operandFundamentalMetricId("fundamental:")).toBeNull();
  });

  it("collects exactly the metrics a Strategy names, once each, across levels", () => {
    const definition = normalizeStrategyDefinition({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "a",
                metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 15 },
              },
              {
                id: "b",
                metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
                operator: "IS_BELOW",
                value: { kind: "MULTIPLE", value: 1 },
              },
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: "sell-1",
          percentage: 50,
          signal: {
            conditions: [
              {
                id: "c",
                metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                operator: "IS_BELOW",
                value: { kind: "PERCENT", value: 5 },
              },
            ],
          },
        },
      ],
    });
    expect(collectOperands(definition)).toEqual([
      "fundamental:DEBT_TO_EQUITY",
      "fundamental:ROIC_TTM",
      "price",
    ]);
  });
});

describe("the evaluation frame reads exactly the persisted field (audit section 17)", () => {
  const security: Security = {
    id: "audit-projection",
    symbol: "APRJ",
    name: "Audit Projection",
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  };
  const dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"];
  const prices: DailyPrice[] = dates.map((date, index) => ({
    securityId: security.id,
    date,
    open: 10,
    high: 10,
    low: 10,
    close: 10 + index,
    volume: 1_000,
  }));
  /**
   * A distinct literal per metric and session, written into the ADR's storage field, so a reader
   * that took any other field — another metric's, or its own on another day — cannot agree.
   *
   * Session 0: a positive reading, unique per metric. Session 1: a real zero. Session 2: a negative
   * reading. Session 3: unavailable (the field is absent from the row).
   */
  const reading = (metricIndex: number, session: number): number | undefined =>
    session === 0
      ? 10 + metricIndex + (metricIndex + 1) / 1_000
      : session === 1
        ? 0
        : session === 2
          ? -(1 + metricIndex / 100)
          : undefined;
  const derived: DailyDerivedState[] = dates.map((date, session) => {
    const row: Record<string, unknown> = { securityId: security.id, date };
    FUNDAMENTAL_AUDIT_METRICS.forEach((metric, metricIndex) => {
      const value = reading(metricIndex, session);
      if (value !== undefined) {
        row[metric.field] = value;
      }
    });
    return row as DailyDerivedState;
  });

  it("projects all fifteen: value -> value, 0 -> 0, negative -> negative, absent -> NaN, no scaling", () => {
    const operands = FUNDAMENTAL_AUDIT_METRICS.map((metric) =>
      fundamentalMetricOperand(metric.id as never),
    );
    const { frame, diagnostics } = projectEvaluationFrame({
      security,
      prices,
      derived,
      operands: ["price", ...operands],
      periodStart: dates[0]!,
    });
    expect(diagnostics.datesWithoutDerivedState).toBe(0);
    FUNDAMENTAL_AUDIT_METRICS.forEach((metric, metricIndex) => {
      const key = fundamentalMetricOperand(metric.id as never);
      dates.forEach((date, session) => {
        const expected = reading(metricIndex, session);
        const actual = readOperand(frame, key, session);
        if (expected === undefined) {
          expect(actual, `${metric.id} ${date}`).toBeNaN();
        } else {
          expect(
            Object.is(actual, expected),
            `${metric.id} ${date}: ${actual}`,
          ).toBe(true);
        }
      });
    });
  });

  it("projects only the requested metrics, and a missing column reads NaN, never zero", () => {
    const { frame } = projectEvaluationFrame({
      security,
      prices,
      derived,
      operands: ["price", "fundamental:ROIC_TTM"],
      periodStart: dates[0]!,
    });
    expect([...frame.columns.keys()]).toEqual(["fundamental:ROIC_TTM"]);
    expect(readOperand(frame, "fundamental:ROE_TTM", 0)).toBeNaN();
    expect(() =>
      projectEvaluationFrame({
        security,
        prices,
        derived,
        operands: ["price", "fundamental:roic_ttm"],
        periodStart: dates[0]!,
      }),
    ).toThrow();
  });

  it("decides strict comparisons on the stored value: equality is FALSE, absence NOT_EVALUABLE, never zero", () => {
    const roicIndex = FUNDAMENTAL_AUDIT_METRIC_IDS.indexOf("ROIC_TTM");
    const { frame } = projectEvaluationFrame({
      security,
      prices,
      derived,
      operands: ["price", "fundamental:ROIC_TTM"],
      periodStart: dates[0]!,
    });
    const condition = (operator: "IS_ABOVE" | "IS_BELOW", value: number) => ({
      id: "roic",
      metric: { kind: "FUNDAMENTAL" as const, metricId: "ROIC_TTM" as const },
      operator,
      value: { kind: "PERCENT" as const, value },
    });
    const stored = reading(roicIndex, 0)!;
    expect(
      evaluateMarketCondition(condition("IS_ABOVE", stored), frame, 0),
    ).toBe(Evaluability.FALSE);
    expect(
      evaluateMarketCondition(condition("IS_BELOW", stored), frame, 0),
    ).toBe(Evaluability.FALSE);
    expect(evaluateMarketCondition(condition("IS_ABOVE", -0.5), frame, 1)).toBe(
      Evaluability.TRUE,
    );
    expect(evaluateMarketCondition(condition("IS_BELOW", 0), frame, 2)).toBe(
      Evaluability.TRUE,
    );
    // Unavailable reads as neither a pass nor a zero: `ROIC is below 1` must not match it.
    expect(evaluateMarketCondition(condition("IS_BELOW", 1), frame, 3)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
    expect(evaluateMarketCondition(condition("IS_ABOVE", -1e9), frame, 3)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });
});
