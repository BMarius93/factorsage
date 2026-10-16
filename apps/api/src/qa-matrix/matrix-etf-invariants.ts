import type {
  BacktestRunSnapshot,
  StrategyCondition,
  StrategyDefinition,
  StrategyMetric,
  StrategyValue,
} from "@intrinsic/contracts";
import {
  oracleConditionTruth,
  type OracleColumns,
  type OracleOperand,
  type OracleTruth,
} from "./matrix-etf-oracle";
import type { InvariantResult } from "./matrix-invariants";

/**
 * The invariants of the two data-source dimensions (`E` and `T`), settled against the independent
 * ETF oracle (`matrix-etf-oracle.ts`) and the run's own persisted evidence.
 *
 * Numbered after the forty of `matrix-invariants.ts` and appended only to runs whose snapshot reads
 * an ETF, so every other dimension's report is unchanged.
 *
 * | #  | Invariant                                                                   |
 * | -- | --------------------------------------------------------------------------- |
 * | 41 | every ETF Condition of an executed trade's level was TRUE on its session     |
 * | 42 | the snapshot pins exactly the funds the definition and the frozen sectors read |
 * | 43 | Stock's Sector reads the fund its frozen FMP sector maps to, and nothing else |
 * | 44 | every pinned fund was READY for the run                                      |
 *
 * 41 is the one that makes a zero-trade run insufficient: whatever a run did trade, each ETF rule
 * behind it must re-derive as TRUE from the fund's stored bars. A worker that read the wrong fund,
 * carried a value forward across a gap, revealed a week early or evaluated before warm-up produces
 * trades the oracle refuses.
 */

/**
 * The product's sector → fund mapping, **restated** rather than imported: invariant 43 exists to
 * notice the registry drifting, so it must not read the registry it checks.
 * (`docs/decisions/strategy-etf-conditions-v1.md`, Stock's Sector.)
 */
const SECTOR_FUNDS: Readonly<Record<string, string>> = {
  Technology: "ETF_XLK",
  "Financial Services": "ETF_XLF",
  Energy: "ETF_XLE",
  Healthcare: "ETF_XLV",
  Industrials: "ETF_XLI",
  "Consumer Cyclical": "ETF_XLY",
  "Consumer Defensive": "ETF_XLP",
  Utilities: "ETF_XLU",
  "Basic Materials": "ETF_XLB",
  "Real Estate": "ETF_XLRE",
  "Communication Services": "ETF_XLC",
};

export type EtfRunEvidence = {
  /** The oracle columns of every fund the snapshot pins, by series id. */
  readonly oracleBySeriesId: ReadonlyMap<string, OracleColumns>;
  /** `BacktestRunSummary.etfConditionDiagnostics` as persisted. */
  readonly diagnostics: unknown;
  /** Each snapshot security's sector as the catalog stores it now. */
  readonly currentSectorBySecurityId: ReadonlyMap<string, string | null>;
};

type SourcedCondition = StrategyCondition & {
  readonly metric: StrategyMetric & {
    readonly source:
      | { readonly kind: "ETF"; readonly code: string }
      | { readonly kind: "STOCK_SECTOR" };
  };
};

function sourceOf(
  metric: StrategyMetric,
): { kind: "ETF"; code: string } | { kind: "STOCK_SECTOR" } | undefined {
  return "source" in metric && metric.source
    ? (metric.source as
        { kind: "ETF"; code: string } | { kind: "STOCK_SECTOR" })
    : undefined;
}

function isSourced(
  condition: StrategyCondition,
): condition is SourcedCondition {
  return sourceOf(condition.metric) !== undefined;
}

function metricOperand(metric: StrategyMetric): OracleOperand {
  switch (metric.kind) {
    case "PRICE":
      return { kind: "CLOSE" };
    case "MOVING_AVERAGE":
    case "OSCILLATOR":
      return { kind: "COLUMN", field: metric.seriesId };
    case "RELATIVE_VOLUME":
      return { kind: "COLUMN", field: `RVOL_${metric.period}` };
    default:
      throw new Error(`An ETF Condition cannot read a ${metric.kind} metric.`);
  }
}

function valueOperand(value: StrategyValue): OracleOperand {
  switch (value.kind) {
    case "SERIES":
      return { kind: "COLUMN", field: value.seriesId };
    case "NUMBER":
    case "MULTIPLE":
    case "PERCENT":
      return { kind: "CONSTANT", value: value.value };
    default:
      throw new Error(
        `An ETF Condition cannot compare with a ${(value as StrategyValue).kind} value.`,
      );
  }
}

/** The fund one sourced condition reads for one security, or `null` (frozen sector unresolved). */
function fundFor(
  condition: SourcedCondition,
  security: BacktestRunSnapshot["securities"][number] | undefined,
): string | null {
  const source = sourceOf(condition.metric);
  if (!source) {
    return null;
  }
  return source.kind === "ETF"
    ? source.code
    : (security?.sector?.etfCode ?? null);
}

function seriesIdByCode(snapshot: BacktestRunSnapshot): Map<string, string> {
  return new Map(
    (snapshot.etfSeries ?? []).map((pin) => [pin.code, pin.seriesId]),
  );
}

/** One sourced condition on one session for one security, through the oracle. */
export function sourcedConditionTruth(
  condition: SourcedCondition,
  date: string,
  security: BacktestRunSnapshot["securities"][number] | undefined,
  snapshot: BacktestRunSnapshot,
  etf: EtfRunEvidence,
): OracleTruth {
  const code = fundFor(condition, security);
  if (code === null) {
    return "NOT_EVALUABLE";
  }
  const seriesId = seriesIdByCode(snapshot).get(code);
  const columns = seriesId ? etf.oracleBySeriesId.get(seriesId) : undefined;
  if (!columns) {
    return "NOT_EVALUABLE";
  }
  return oracleConditionTruth(
    columns,
    date,
    metricOperand(condition.metric),
    condition.operator as "IS_ABOVE" | "IS_BELOW" | "IS_CLOSE_TO",
    valueOperand(condition.value),
  );
}

function definitionOf(snapshot: BacktestRunSnapshot): StrategyDefinition {
  return snapshot.strategy.definition as unknown as StrategyDefinition;
}

/** Whether a frozen definition reads any ETF or Stock's Sector source. */
export function snapshotReadsEtf(snapshot: BacktestRunSnapshot): boolean {
  return (
    (snapshot.etfSeries?.length ?? 0) > 0 || readsSector(definitionOf(snapshot))
  );
}

function signalsOf(definition: StrategyDefinition) {
  return [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules ?? []).map((rule) => rule.signal),
  ];
}

function readsSector(definition: StrategyDefinition): boolean {
  return signalsOf(definition).some((signal) =>
    signal.conditions.some(
      (condition) => sourceOf(condition.metric)?.kind === "STOCK_SECTOR",
    ),
  );
}

function staticCodes(definition: StrategyDefinition): Set<string> {
  const codes = new Set<string>();
  for (const signal of signalsOf(definition)) {
    for (const condition of signal.conditions) {
      const source = sourceOf(condition.metric);
      if (source?.kind === "ETF") {
        codes.add(source.code);
      }
    }
  }
  return codes;
}

type TradeLike = {
  readonly sequence: number;
  readonly date: string;
  readonly securityId: string;
  readonly symbol: string;
  readonly action: "BUY" | "SELL" | "FINAL_EXIT";
  readonly levelId: string | null;
};

const VIOLATION_CAP = 8;

function result(
  id: number,
  key: string,
  title: string,
  violations: readonly string[],
  indeterminate: readonly string[],
  passDetail: string,
): InvariantResult {
  if (violations.length > 0) {
    return {
      id,
      key,
      title,
      status: "FAIL",
      detail: `${violations.length} violation${violations.length === 1 ? "" : "s"}`,
      violations:
        violations.length <= VIOLATION_CAP
          ? violations
          : [
              ...violations.slice(0, VIOLATION_CAP),
              `… and ${violations.length - VIOLATION_CAP} more`,
            ],
    };
  }
  if (indeterminate.length > 0) {
    return {
      id,
      key,
      title,
      status: "INDETERMINATE",
      detail: `${indeterminate.length} comparison(s) within the oracle's floating-point ambiguity`,
      violations: indeterminate.slice(0, VIOLATION_CAP),
    };
  }
  return { id, key, title, status: "PASS", detail: passDetail };
}

/** Invariants 41–44 for one run whose snapshot reads an ETF. */
export function validateEtfInvariants(input: {
  readonly snapshot: BacktestRunSnapshot;
  readonly trades: readonly TradeLike[];
  readonly etf: EtfRunEvidence;
}): InvariantResult[] {
  const { snapshot, trades, etf } = input;
  const definition = definitionOf(snapshot);
  const securities = new Map(
    snapshot.securities.map((security) => [security.securityId, security]),
  );
  const results: InvariantResult[] = [];

  // ---- 41 -------------------------------------------------------------------------------------
  const violations41: string[] = [];
  const ambiguous41: string[] = [];
  let checked = 0;
  const buyLevels = new Map(
    definition.buyLevels.map((level) => [level.id, level]),
  );
  const sellLevels = new Map(
    definition.sellLevels.map((level) => [level.id, level]),
  );
  const exitRules = definition.finalExit?.rules ?? [];
  for (const trade of trades) {
    // A trade with no level is the end-of-period liquidation a completed run ends in cash with: no
    // Signal decided it, so there is no Condition to re-derive.
    if (trade.levelId === null) {
      continue;
    }
    const security = securities.get(trade.securityId);
    const judge = (conditions: readonly StrategyCondition[]): OracleTruth[] =>
      conditions
        .filter(isSourced)
        .map((condition) =>
          sourcedConditionTruth(condition, trade.date, security, snapshot, etf),
        );
    const label = `#${trade.sequence} ${trade.action} ${trade.symbol} ${trade.date}`;
    if (trade.action === "BUY" || trade.action === "SELL") {
      const level =
        trade.action === "BUY"
          ? buyLevels.get(trade.levelId ?? "")
          : sellLevels.get(trade.levelId ?? "");
      if (!level) {
        violations41.push(
          `${label}: level \`${trade.levelId}\` is not in the frozen definition`,
        );
        continue;
      }
      const truths = judge(level.signal.conditions);
      if (truths.length === 0) {
        continue;
      }
      checked += 1;
      if (
        truths.some((truth) => truth === "FALSE" || truth === "NOT_EVALUABLE")
      ) {
        violations41.push(
          `${label}: ETF Condition(s) ${truths.join("/")} on the trade's session`,
        );
      } else if (truths.includes("AMBIGUOUS")) {
        ambiguous41.push(`${label}: ${truths.join("/")}`);
      }
    } else {
      // FINAL EXIT is reached by any one of its Exit Rules. Only a trade that **every** rule's ETF
      // Conditions forbid is a violation: a rule with no ETF Condition, or whose ETF Conditions all
      // hold, may be the one that fired.
      const verdicts = exitRules.map((rule) => judge(rule.signal.conditions));
      if (verdicts.every((truths) => truths.length === 0)) {
        continue;
      }
      checked += 1;
      const anyCanFire = verdicts.some(
        (truths) =>
          truths.length === 0 || truths.every((truth) => truth === "TRUE"),
      );
      const anyAmbiguous = verdicts.some(
        (truths) =>
          truths.includes("AMBIGUOUS") &&
          truths.every((truth) => truth === "TRUE" || truth === "AMBIGUOUS"),
      );
      if (!anyCanFire) {
        if (anyAmbiguous) {
          ambiguous41.push(
            `${label}: ${verdicts.map((truths) => truths.join("/")).join(" | ")}`,
          );
        } else {
          violations41.push(
            `${label}: no Exit Rule's ETF Conditions hold (${verdicts
              .map((truths) => truths.join("/"))
              .join(" | ")})`,
          );
        }
      }
    }
  }
  results.push(
    result(
      41,
      "etf-conditions-held",
      "Every executed trade's ETF Conditions held (independent oracle)",
      violations41,
      ambiguous41,
      `${checked} ETF-gated trade(s) re-derived TRUE from the funds' stored bars`,
    ),
  );

  // ---- 42 -------------------------------------------------------------------------------------
  const violations42: string[] = [];
  const expected = staticCodes(definition);
  if (readsSector(definition)) {
    for (const security of snapshot.securities) {
      if (security.sector?.etfCode) {
        expected.add(security.sector.etfCode);
      }
    }
  }
  const pinned = new Set((snapshot.etfSeries ?? []).map((pin) => pin.code));
  for (const code of expected) {
    if (!pinned.has(code)) {
      violations42.push(`\`${code}\` is read but not pinned`);
    }
  }
  for (const code of pinned) {
    if (!expected.has(code)) {
      violations42.push(`\`${code}\` is pinned but nothing reads it`);
    }
  }
  for (const pin of snapshot.etfSeries ?? []) {
    if (!etf.oracleBySeriesId.has(pin.seriesId)) {
      violations42.push(
        `\`${pin.code}\` pins series ${pin.seriesId}, which has no stored bars`,
      );
    }
  }
  results.push(
    result(
      42,
      "etf-sources-pinned",
      "The snapshot pins exactly the funds the strategy reads",
      violations42,
      [],
      `${pinned.size} fund(s) pinned, each read and each stored`,
    ),
  );

  // ---- 43 -------------------------------------------------------------------------------------
  if (readsSector(definition)) {
    const violations43: string[] = [];
    for (const security of snapshot.securities) {
      const frozen = security.sector;
      if (!frozen) {
        violations43.push(
          `${security.symbol} has no frozen sector although the strategy reads one`,
        );
        continue;
      }
      const mapped =
        frozen.name === null ? null : (SECTOR_FUNDS[frozen.name] ?? null);
      if (frozen.etfCode !== mapped) {
        violations43.push(
          `${security.symbol}: frozen sector \`${frozen.name}\` names ${frozen.etfCode}, the mapping says ${mapped}`,
        );
      }
      const current =
        etf.currentSectorBySecurityId.get(security.securityId) ?? null;
      if (current !== frozen.name) {
        violations43.push(
          `${security.symbol}: frozen sector \`${frozen.name}\` differs from the catalog's \`${current}\``,
        );
      }
    }
    results.push(
      result(
        43,
        "stock-sector-frozen",
        "Stock's Sector reads the fund its frozen sector maps to",
        violations43,
        [],
        `${snapshot.securities.length} frozen sector(s) consistent with the mapping and the catalog`,
      ),
    );
  } else {
    for (const security of snapshot.securities) {
      if (security.sector) {
        results.push(
          result(
            43,
            "stock-sector-frozen",
            "Stock's Sector reads the fund its frozen sector maps to",
            [
              `${security.symbol} carries a frozen sector although the strategy reads none`,
            ],
            [],
            "",
          ),
        );
        break;
      }
    }
  }

  // ---- 44 -------------------------------------------------------------------------------------
  const violations44: string[] = [];
  const rows = Array.isArray(etf.diagnostics)
    ? (etf.diagnostics as { code?: unknown; status?: unknown }[])
    : [];
  const byCode = new Map(
    rows.map((row) => [String(row.code), String(row.status)]),
  );
  for (const code of pinned) {
    const status = byCode.get(code);
    if (status !== "READY") {
      violations44.push(
        `\`${code}\` diagnostics status ${status ?? "missing"}`,
      );
    }
  }
  results.push(
    result(
      44,
      "etf-diagnostics-ready",
      "Every pinned fund was READY for the run",
      violations44,
      [],
      `${pinned.size} fund(s) READY`,
    ),
  );

  return results;
}

/** TRUE / FALSE / NOT_EVALUABLE / AMBIGUOUS counts of one sourced Condition over a run. */
export type ConditionTally = {
  readonly strategyId: string;
  readonly conditionId: string;
  readonly fund: string;
  TRUE: number;
  FALSE: number;
  NOT_EVALUABLE: number;
  AMBIGUOUS: number;
};

/**
 * How each sourced Condition of a run evaluated over the sessions the run simulated — the evidence
 * that a dimension exercised TRUE, FALSE and NOT_EVALUABLE, which no count of trades can give.
 * A static ETF Condition is the same for every stock and is tallied once per session; a Stock's
 * Sector Condition once per session per distinct fund the run's members read.
 */
export function tallySourcedConditions(input: {
  readonly strategyId: string;
  readonly snapshot: BacktestRunSnapshot;
  readonly sessions: readonly string[];
  readonly etf: EtfRunEvidence;
}): ConditionTally[] {
  const { snapshot, sessions, etf } = input;
  const definition = definitionOf(snapshot);
  const tallies: ConditionTally[] = [];
  const representatives = new Map<
    string,
    BacktestRunSnapshot["securities"][number]
  >();
  for (const security of snapshot.securities) {
    const code = security.sector?.etfCode;
    if (code && !representatives.has(code)) {
      representatives.set(code, security);
    }
  }
  for (const signal of signalsOf(definition)) {
    for (const condition of signal.conditions.filter(isSourced)) {
      const source = sourceOf(condition.metric);
      const targets =
        source?.kind === "ETF"
          ? [{ fund: source.code, security: undefined }]
          : [...representatives].map(([fund, security]) => ({
              fund,
              security,
            }));
      for (const target of targets) {
        const tally: ConditionTally = {
          strategyId: input.strategyId,
          conditionId: condition.id,
          fund: target.fund,
          TRUE: 0,
          FALSE: 0,
          NOT_EVALUABLE: 0,
          AMBIGUOUS: 0,
        };
        for (const date of sessions) {
          tally[
            sourcedConditionTruth(
              condition,
              date,
              target.security,
              snapshot,
              etf,
            )
          ] += 1;
        }
        tallies.push(tally);
      }
    }
  }
  return tallies;
}
