import type { StrategySignal } from "@intrinsic/contracts";
import {
  createEvaluationFrame,
  evaluabilityAll,
  evaluabilityAny,
  evaluateConditionValues,
  evaluateMarketSignal,
  evaluateTriggerValues,
  type Evaluability,
} from "@intrinsic/strategy";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import {
  and,
  compare,
  cross,
  or,
  signalValue,
  type MarketRow,
  type Tri,
} from "../oracle/predicates";
import { parseOracleStrategy } from "../oracle/strategy-model";

/**
 * Production Strategy evaluation against the reference evaluator on constructed inputs: every
 * operator at and around its boundaries, missing data, and randomly composed Signals over frames
 * with holes. Real-data evaluation over the matrix frames is the backtest section's
 * `strategies/real-frame-evaluation.json`.
 */

const TRI = (value: Evaluability): Tri =>
  value === 2 ? "TRUE" : value === 1 ? "FALSE" : "NOT_EVALUABLE";

/** Deterministic PRNG, so a failing case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runStrategyDifferential(writer: AuditWriter): {
  ledger: ComparisonLedger;
  traces: Record<string, unknown>[];
} {
  const ledger = new ComparisonLedger(200);
  const traces: Record<string, unknown>[] = [];
  const values = [
    -100,
    -1,
    -0.5,
    0,
    0.5,
    1,
    30,
    70,
    100,
    1_000_000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  const factors = [
    1,
    1 + 1e-15,
    1 - 1e-15,
    1.02,
    0.98,
    1.02 + 1e-12,
    0.98 - 1e-12,
    1.0199999999,
    0.9800000001,
    1.5,
    0.5,
    -1,
  ];
  const trace = (
    kind: string,
    operator: string,
    metric: number,
    value: number,
    expected: Tri,
    actual: Tri,
    previous?: [number, number],
  ): void => {
    if (
      traces.length < 120 &&
      (expected !== actual || traces.length % 7 === 0)
    ) {
      traces.push({
        kind,
        operator,
        metric,
        value,
        previousMetric: previous?.[0],
        previousValue: previous?.[1],
        expected,
        actual,
        result: expected === actual ? "PASS" : "FAIL",
      });
    }
  };

  // Conditions at the boundaries.
  for (const operator of ["IS_ABOVE", "IS_BELOW", "IS_CLOSE_TO"] as const) {
    for (const value of values) {
      for (const factor of factors) {
        const metric = Number.isFinite(value) ? value * factor : factor;
        for (const [m, v] of [
          [metric, value],
          [value, metric],
        ] as const) {
          const expected = compare(operator, m, v);
          const actual = TRI(evaluateConditionValues(operator, m, v));
          trace("condition", operator, m, v, expected, actual);
          ledger.check(
            "strategy-operators",
            `${operator}(${m}, ${v})`,
            expected,
            actual,
            "exact-text",
          );
        }
      }
    }
  }
  // Triggers at the boundaries: every combination of equal / above / below at t and t-1.
  const triples = [-1, 0, 1, Number.NaN];
  for (const operator of ["CROSSES_ABOVE", "CROSSES_BELOW"] as const) {
    for (const now of triples) {
      for (const before of triples) {
        for (const base of [0, 10, -5]) {
          const m = base + (Number.isNaN(now) ? Number.NaN : now);
          const pm = base + (Number.isNaN(before) ? Number.NaN : before);
          const expected = cross(operator, m, base, pm, base);
          const actual = TRI(
            evaluateTriggerValues(operator, m, base, pm, base),
          );
          trace("trigger", operator, m, base, expected, actual, [pm, base]);
          ledger.check(
            "strategy-operators",
            `${operator}(${m}, ${base}; ${pm}, ${base})`,
            expected,
            actual,
            "exact-text",
          );
        }
      }
    }
  }

  // Randomly composed Signals over frames with holes (NaN = absent), market metrics only.
  const random = mulberry32(20260922);
  const seriesIds = ["SMA_50D", "SMA_200D", "EMA_20D", "RSI_14D", "SMA_20W"];
  const metrics = [
    { kind: "PRICE" },
    { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
    { kind: "MOVING_AVERAGE", seriesId: "EMA_20D" },
    { kind: "OSCILLATOR", seriesId: "RSI_14D" },
    { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
  ];
  for (let sample = 0; sample < 400; sample += 1) {
    const length = 30;
    const dates = Array.from(
      { length },
      (_, index) => `2024-01-${String(index + 1).padStart(2, "0")}`,
    );
    const column = (scale: number, holes: number): Float64Array =>
      Float64Array.from({ length }, () =>
        random() < holes ? Number.NaN : scale * (0.8 + random() * 0.4),
      );
    const columns = new Map<string, Float64Array>();
    for (const id of seriesIds) {
      columns.set(`series:${id}`, column(id.startsWith("RSI") ? 50 : 100, 0.1));
    }
    columns.set("margin-of-safety:DCF_FCFF", column(20, 0.2));
    const closes = column(100, 0.05);
    const frame = createEvaluationFrame({
      securityId: "s",
      symbol: "S",
      name: "S",
      dates,
      closes,
      columns,
      periodStartIndex: 0,
    });
    const predicate = (
      id: string,
      trigger: boolean,
    ): Record<string, unknown> => {
      const metric = metrics[Math.floor(random() * metrics.length)]!;
      const isRsi = metric.kind === "OSCILLATOR";
      const isMos = metric.kind === "MARGIN_OF_SAFETY";
      const operator = trigger
        ? random() < 0.5
          ? "CROSSES_ABOVE"
          : "CROSSES_BELOW"
        : ["IS_ABOVE", "IS_BELOW", ...(isRsi || isMos ? [] : ["IS_CLOSE_TO"])][
            Math.floor(random() * (isRsi || isMos ? 2 : 3))
          ];
      const value = isRsi
        ? { kind: "NUMBER", value: Math.round(random() * 99) + 1 }
        : isMos
          ? { kind: "PERCENT", value: Math.round(random() * 60) - 20 }
          : { kind: "SERIES", seriesId: seriesIds[Math.floor(random() * 3)]! };
      return { id, metric, operator, value };
    };
    const signal = {
      conditions: Array.from({ length: Math.floor(random() * 4) }, (_, index) =>
        predicate(`c${index}`, false),
      ),
      ...(random() < 0.6 ? { trigger: predicate("t", true) } : {}),
    };
    if (signal.conditions.length === 0 && !("trigger" in signal)) {
      signal.conditions.push(predicate("c0", false));
    }
    const oracleSignal = parseOracleStrategy({
      buyLevels: [{ id: "b", percentage: 100, signal }],
      sellLevels: [],
    }).buyLevels[0]!.signal;
    const rows: MarketRow[] = dates.map((date, index) => ({
      date,
      close: closes[index]!,
      values: new Map(
        [...columns.entries()]
          .filter(([, values]) => !Number.isNaN(values[index]!))
          .map(([key, values]) => [key, values[index]!]),
      ),
    }));
    for (let index = 0; index < length; index += 1) {
      const expected = signalValue(
        oracleSignal,
        rows[index]!,
        index > 0 ? rows[index - 1]! : null,
        null,
      );
      const actual = TRI(
        evaluateMarketSignal(signal as unknown as StrategySignal, frame, index),
      );
      ledger.check(
        "strategy-signals",
        `sample ${sample} row ${index}`,
        expected,
        actual,
        "exact-text",
      );
      if (expected !== actual && traces.length < 150) {
        traces.push({
          kind: "signal",
          sample,
          index,
          signal,
          expected,
          actual,
          result: "FAIL",
        });
      }
    }
  }

  // FINAL EXIT: OR across Exit Rules of AND within each rule, over every combination of 3 rules.
  const states: Evaluability[] = [0, 1, 2] as Evaluability[];
  for (const a of states) {
    for (const b of states) {
      for (const c of states) {
        for (const d of states) {
          const production = evaluabilityAny([
            evaluabilityAll([a, b]),
            evaluabilityAll([c]),
            evaluabilityAll([d, a]),
          ]);
          const reference = or([
            and([TRI(a), TRI(b)]),
            and([TRI(c)]),
            and([TRI(d), TRI(a)]),
          ]);
          ledger.check(
            "strategy-final-exit-or",
            `(${a}&${b}) | (${c}) | (${d}&${a})`,
            reference,
            TRI(production),
            "exact-text",
          );
        }
      }
    }
  }

  writer.writeJson("strategies/differential.json", {
    description:
      "Production operators, Signals and FINAL EXIT composition against the reference evaluator on constructed boundary and random inputs.",
    comparisons: ledger.totals(),
    byCategory: ledger.byCategory(),
    differences: ledger.differences,
    traces,
  });
  return { ledger, traces };
}
