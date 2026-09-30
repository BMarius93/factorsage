import { createHash } from "node:crypto";
import {
  strategyDefinitionFingerprint,
  strategyFinalExitFingerprint,
  strategySignalFingerprint,
  type StrategyDefinition,
  type StrategyFinalExit,
  type StrategyMetric,
  type StrategySignal,
  type StrategyValue,
} from "@intrinsic/contracts";

/**
 * A fixed corpus of **non-Fundamental** Strategy logic, fingerprinted every way the product
 * fingerprints it.
 *
 * Fundamental Metrics added a metric kind and rewrote the identity functions as exhaustive switches.
 * Nothing that existed before may have moved: a changed serialization would change every stored
 * `StrategyVersion.definitionHash` it touched and reset the Monitor latch of every affected level.
 * The corpus below was fingerprinted on `main` at `e0045acd` — the commit before the Strategy slice
 * merged — and the digests are pinned in `strategy-audit.test.ts`; the full corpus (5,760 cases,
 * six fingerprints each) was also compared line by line on both commits and was byte-identical.
 *
 * Validity is deliberately ignored: the fingerprint is a serialization, and a corpus that only held
 * valid rules would not notice a serializer that special-cased an invalid one.
 */

const MOVING_AVERAGES = [
  "SMA_20D",
  "SMA_50D",
  "SMA_100D",
  "SMA_200D",
  "EMA_20D",
  "EMA_50D",
  "EMA_200D",
  "SMA_20W",
  "SMA_50W",
  "SMA_100W",
  "SMA_200W",
  "EMA_20W",
  "EMA_50W",
  "EMA_200W",
] as const;
const OSCILLATORS = ["RSI_7D", "RSI_14D", "RSI_21D"] as const;
const VALUATION_SOURCES = [
  "DCF_FCFF",
  "RESIDUAL_INCOME",
  "DDM",
  "GRAHAM",
  "BALANCED",
  "CONSERVATIVE",
  "DIVIDEND",
] as const;

function corpusMetrics(): StrategyMetric[] {
  const metrics: StrategyMetric[] = [{ kind: "PRICE" }];
  for (const seriesId of MOVING_AVERAGES) {
    metrics.push({ kind: "MOVING_AVERAGE", seriesId });
  }
  for (const seriesId of OSCILLATORS) {
    metrics.push({ kind: "OSCILLATOR", seriesId });
  }
  for (const period of [10, 20, 50] as const) {
    metrics.push({ kind: "RELATIVE_VOLUME", period });
  }
  for (const sourceId of VALUATION_SOURCES) {
    metrics.push({ kind: "MARGIN_OF_SAFETY", sourceId });
  }
  metrics.push({ kind: "GAIN" }, { kind: "LOSS" });
  for (const measure of [
    "BUYERS",
    "SELLERS",
    "PURCHASE_VALUE",
    "SALE_VALUE",
  ] as const) {
    for (const lookback of [5, 250] as const) {
      for (const roles of [
        undefined,
        ["CEO", "CFO"] as const,
        ["TEN_PERCENT_OWNER"] as const,
      ]) {
        metrics.push({
          kind: "INSIDER_ACTIVITY",
          measure,
          lookback,
          ...(roles ? { roles } : {}),
        });
      }
    }
  }
  for (const measure of [
    "PURCHASES",
    "SALES",
    "BUYERS",
    "SELLERS",
    "MINIMUM_PURCHASE_VALUE",
  ] as const) {
    for (const scope of [
      { kind: "ANY" } as const,
      { kind: "ACTOR", actorId: "P000197" } as const,
      { kind: "GROUP", groupId: "group-1" } as const,
    ]) {
      for (const chamber of ["ANY", "HOUSE", "SENATE"] as const) {
        for (const owners of [undefined, ["SELF", "SPOUSE"] as const]) {
          metrics.push({
            kind: "CONGRESS_ACTIVITY",
            measure,
            lookback: 20,
            scope,
            chamber,
            ...(owners ? { owners } : {}),
          });
        }
      }
    }
  }
  return metrics;
}

const OPERATORS = [
  "IS_ABOVE",
  "IS_BELOW",
  "IS_CLOSE_TO",
  "CROSSES_ABOVE",
  "CROSSES_BELOW",
] as const;

const VALUES: readonly StrategyValue[] = [
  { kind: "NUMBER", value: 30 },
  { kind: "NUMBER", value: 0 },
  { kind: "PERCENT", value: 15 },
  { kind: "PERCENT", value: -12.5 },
  { kind: "MULTIPLE", value: 1.5 },
  { kind: "MONEY", value: 1_000_000 },
  { kind: "SERIES", seriesId: "SMA_50D" },
  { kind: "SERIES", seriesId: "EMA_20W" },
];

export type FingerprintCorpusRow = {
  key: string;
  family: string;
  condition: string;
  trigger: string;
  mixed: string;
  definition: string;
  finalExitMulti: string;
  finalExitSingle: string;
};

/** Every case of the corpus with its six fingerprints, in a fixed order. */
export function fingerprintCorpus(): FingerprintCorpusRow[] {
  const rows: FingerprintCorpusRow[] = [];
  let sequence = 0;
  // Predicate ids carry no meaning in a fingerprint; they only have to exist.
  const predicate = (
    metric: StrategyMetric,
    operator: string,
    value: StrategyValue,
  ) => ({ id: `c${sequence++}`, metric, operator, value }) as never;
  for (const metric of corpusMetrics()) {
    for (const operator of OPERATORS) {
      for (const value of VALUES) {
        const conditionSignal: StrategySignal = {
          conditions: [predicate(metric, operator, value)],
        };
        const triggerSignal: StrategySignal = {
          conditions: [],
          trigger: predicate(metric, operator, value),
        };
        const mixed: StrategySignal = {
          conditions: [
            predicate({ kind: "PRICE" }, "IS_ABOVE", {
              kind: "SERIES",
              seriesId: "SMA_200D",
            }),
            predicate(metric, operator, value),
          ],
          trigger: predicate(
            { kind: "OSCILLATOR", seriesId: "RSI_14D" },
            "CROSSES_ABOVE",
            { kind: "NUMBER", value: 30 },
          ),
        };
        const finalExit = {
          rules: [
            {
              id: "r1",
              signal: {
                conditions: [
                  predicate({ kind: "GAIN" }, "IS_ABOVE", {
                    kind: "PERCENT",
                    value: 40,
                  }),
                ],
              },
            },
            { id: "r2", signal: conditionSignal },
          ],
        } as unknown as StrategyFinalExit;
        const definition = {
          schemaVersion: 2,
          buyLevels: [
            { id: "b1", percentage: 50, signal: conditionSignal },
            { id: "b2", percentage: 100, signal: mixed },
          ],
          sellLevels: [{ id: "s1", percentage: 50, signal: triggerSignal }],
          finalExit,
        } as unknown as StrategyDefinition;
        const singleRule = {
          rules: [{ id: "r1", signal: mixed }],
        } as unknown as StrategyFinalExit;
        rows.push({
          key: `${JSON.stringify(metric)}|${operator}|${JSON.stringify(value)}`,
          family: metric.kind,
          condition: strategySignalFingerprint(conditionSignal),
          trigger: strategySignalFingerprint(triggerSignal),
          mixed: strategySignalFingerprint(mixed),
          definition: strategyDefinitionFingerprint(definition),
          finalExitMulti: strategyFinalExitFingerprint(finalExit),
          finalExitSingle: strategyFinalExitFingerprint(singleRule),
        });
      }
    }
  }
  return rows;
}

/** SHA-256 over every fingerprint of the rows, one line per case. */
export function corpusDigest(rows: readonly FingerprintCorpusRow[]): string {
  return createHash("sha256")
    .update(
      rows
        .map((row) =>
          [
            row.key,
            row.condition,
            row.trigger,
            row.mixed,
            row.definition,
            row.finalExitMulti,
            row.finalExitSingle,
          ].join("\u0001"),
        )
        .join("\n"),
    )
    .digest("hex");
}
