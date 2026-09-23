/**
 * The audit oracle's own reading of a Strategy definition document.
 *
 * Written from `ai/product/strategies.md`, deliberately not imported from `@intrinsic/contracts`:
 * the oracle parses the persisted JSON itself, so a contract-level misreading cannot be shared
 * with the engine it is checking.
 *
 * Only what evaluation needs is modelled. Schema version 1 (a flat `finalExit.signal`) is read as
 * the single-rule version 2 document the product says it is equivalent to.
 */

export type OracleMetric =
  | { kind: "PRICE" }
  | { kind: "MOVING_AVERAGE"; seriesId: string }
  | { kind: "OSCILLATOR"; seriesId: string }
  | { kind: "MARGIN_OF_SAFETY"; sourceId: string }
  | { kind: "GAIN" }
  | { kind: "LOSS" };

export type OracleValue =
  | { kind: "SERIES"; seriesId: string }
  | { kind: "NUMBER"; value: number }
  | { kind: "PERCENT"; value: number };

export type OraclePredicate = {
  id: string;
  metric: OracleMetric;
  operator:
    "IS_ABOVE" | "IS_BELOW" | "IS_CLOSE_TO" | "CROSSES_ABOVE" | "CROSSES_BELOW";
  value: OracleValue;
};

export type OracleSignal = {
  conditions: OraclePredicate[];
  trigger: OraclePredicate | null;
};

export type OracleBuyLevel = {
  id: string;
  percentage: number;
  signal: OracleSignal;
};
export type OracleSellLevel = {
  id: string;
  percentage: number;
  signal: OracleSignal;
};
export type OracleExitRule = { id: string; signal: OracleSignal };
export type OracleFinalExit = { id: string; rules: OracleExitRule[] };

export type OracleStrategy = {
  buyLevels: OracleBuyLevel[];
  sellLevels: OracleSellLevel[];
  finalExit: OracleFinalExit | null;
};

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`oracle: ${path} is not an object`);
  }
  return value as Json;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`oracle: ${path} is not a list`);
  }
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`oracle: ${path} is not a string`);
  }
  return value;
}

function metric(value: unknown, path: string): OracleMetric {
  const raw = object(value, path);
  const kind = text(raw.kind, `${path}.kind`);
  switch (kind) {
    case "PRICE":
    case "GAIN":
    case "LOSS":
      return { kind };
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return { kind, seriesId: text(raw.seriesId, `${path}.seriesId`) };
    case "MARGIN_OF_SAFETY":
      return { kind, sourceId: text(raw.sourceId, `${path}.sourceId`) };
    default:
      throw new Error(`oracle: unknown metric kind ${kind} at ${path}`);
  }
}

function comparisonValue(value: unknown, path: string): OracleValue {
  const raw = object(value, path);
  const kind = text(raw.kind, `${path}.kind`);
  if (kind === "SERIES") {
    return { kind, seriesId: text(raw.seriesId, `${path}.seriesId`) };
  }
  if (kind === "NUMBER" || kind === "PERCENT") {
    if (typeof raw.value !== "number") {
      throw new Error(`oracle: ${path}.value is not a number`);
    }
    return { kind, value: raw.value };
  }
  throw new Error(`oracle: unknown value kind ${kind} at ${path}`);
}

function predicate(value: unknown, path: string): OraclePredicate {
  const raw = object(value, path);
  const operator = text(raw.operator, `${path}.operator`);
  if (
    ![
      "IS_ABOVE",
      "IS_BELOW",
      "IS_CLOSE_TO",
      "CROSSES_ABOVE",
      "CROSSES_BELOW",
    ].includes(operator)
  ) {
    throw new Error(`oracle: unknown operator ${operator} at ${path}`);
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    metric: metric(raw.metric, `${path}.metric`),
    operator: operator as OraclePredicate["operator"],
    value: comparisonValue(raw.value, `${path}.value`),
  };
}

function signal(value: unknown, path: string): OracleSignal {
  const raw = object(value, path);
  return {
    conditions: array(raw.conditions ?? [], `${path}.conditions`).map(
      (entry, index) => predicate(entry, `${path}.conditions[${index}]`),
    ),
    trigger:
      raw.trigger === undefined || raw.trigger === null
        ? null
        : predicate(raw.trigger, `${path}.trigger`),
  };
}

export function parseOracleStrategy(document: unknown): OracleStrategy {
  const raw = object(document, "definition");
  const buyLevels = array(raw.buyLevels, "definition.buyLevels").map(
    (entry, index) => {
      const level = object(entry, `buyLevels[${index}]`);
      return {
        id: text(level.id, `buyLevels[${index}].id`),
        percentage: Number(level.percentage),
        signal: signal(level.signal, `buyLevels[${index}].signal`),
      };
    },
  );
  const sellLevels = array(raw.sellLevels ?? [], "definition.sellLevels").map(
    (entry, index) => {
      const level = object(entry, `sellLevels[${index}]`);
      return {
        id: text(level.id, `sellLevels[${index}].id`),
        percentage: Number(level.percentage),
        signal: signal(level.signal, `sellLevels[${index}].signal`),
      };
    },
  );
  let finalExit: OracleFinalExit | null = null;
  if (raw.finalExit !== undefined && raw.finalExit !== null) {
    const exit = object(raw.finalExit, "finalExit");
    const id = text(exit.id, "finalExit.id");
    if (Array.isArray(exit.rules)) {
      finalExit = {
        id,
        rules: exit.rules.map((entry, index) => {
          const rule = object(entry, `finalExit.rules[${index}]`);
          return {
            id: text(rule.id, `finalExit.rules[${index}].id`),
            signal: signal(rule.signal, `finalExit.rules[${index}].signal`),
          };
        }),
      };
    } else {
      // Schema version 1: one flat Signal, which the product defines as the single Exit Rule of
      // an otherwise identical version 2 document; that rule carries the level's own id.
      finalExit = {
        id,
        rules: [{ id, signal: signal(exit.signal, "finalExit.signal") }],
      };
    }
  }
  return { buyLevels, sellLevels, finalExit };
}

/** Whether a metric needs simulated position state (Gain / Loss). */
export function isPositionMetric(value: OracleMetric): boolean {
  return value.kind === "GAIN" || value.kind === "LOSS";
}
