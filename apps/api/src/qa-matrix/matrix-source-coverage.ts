import type {
  StrategyCondition,
  StrategyDefinition,
} from "@intrinsic/contracts";
import {
  QA_MATRIX_METAMORPHIC_PAIRS,
  type QaMatrixFixtures,
  type QaMatrixStrategySet,
} from "@intrinsic/testing";
import type { QaMatrixCase } from "./matrix-case";
import {
  tallySourcedConditions,
  type ConditionTally,
} from "./matrix-etf-invariants";
import type { RunEvidence } from "./matrix-invariants";

/**
 * Proof that a data-source sweep exercised what it was built to exercise.
 *
 * A thousand green runs of `E01` … `E10` would say nothing about ETF Conditions if the funds had
 * been unreadable — every Condition then NOT_EVALUABLE, every run a zero-trade success. So the sweep
 * accumulates, from the independent oracle, how every sourced Condition evaluated on the sessions
 * each run simulated, and how many executed trades an ETF Condition gated, and the gate requires:
 *
 * - every sourced Condition was TRUE on some session and FALSE on another, except the probes;
 * - the always-TRUE probe was never FALSE, and the never-TRUE probe never TRUE — the premises of the
 *   metamorphic pairs, checked rather than assumed;
 * - the funds that list inside the horizon were NOT_EVALUABLE somewhere (`HYG`, `RSP`, `XLRE`,
 *   `XLC`), so the pre-listing path really ran;
 * - every fixture with a sourced Condition traded through it somewhere;
 * - for Stock's Sector, all eleven sector funds were read.
 */

export type SourceCoverageExpectation = {
  readonly expectation: string;
  readonly met: boolean;
  readonly detail: string;
};

const SECTOR_FUNDS = [
  "ETF_XLK",
  "ETF_XLF",
  "ETF_XLE",
  "ETF_XLV",
  "ETF_XLI",
  "ETF_XLY",
  "ETF_XLP",
  "ETF_XLU",
  "ETF_XLB",
  "ETF_XLRE",
  "ETF_XLC",
] as const;

/** Funds that list inside a thirty-year run, so their rules must have been NOT_EVALUABLE. */
const YOUNGER_FUNDS = ["ETF_HYG", "ETF_RSP", "ETF_XLRE", "ETF_XLC"] as const;

type Probe = "ALWAYS_TRUE" | "NEVER_TRUE" | null;

/** Recognized structurally, never by fixture id: the condition itself says what the data makes of it. */
function probeOf(condition: StrategyCondition): Probe {
  const { metric, operator, value } = condition;
  if (
    metric.kind === "RELATIVE_VOLUME" &&
    operator === "IS_ABOVE" &&
    value.kind === "MULTIPLE" &&
    value.value === 0
  ) {
    return "ALWAYS_TRUE";
  }
  if (
    metric.kind === "OSCILLATOR" &&
    operator === "IS_ABOVE" &&
    value.kind === "NUMBER" &&
    value.value >= 100
  ) {
    return "NEVER_TRUE";
  }
  return null;
}

function sourcedConditionsOf(
  definition: StrategyDefinition,
): Map<string, StrategyCondition> {
  const found = new Map<string, StrategyCondition>();
  const signals = [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules ?? []).map((rule) => rule.signal),
  ];
  for (const signal of signals) {
    for (const condition of signal.conditions) {
      if ("source" in condition.metric && condition.metric.source) {
        found.set(condition.id, condition);
      }
    }
  }
  return found;
}

/** Levels (and Exit Rules) that carry at least one sourced Condition. */
function gatedLevelIds(definition: StrategyDefinition): Set<string> {
  const gated = new Set<string>();
  const sourced = (conditions: readonly StrategyCondition[]): boolean =>
    conditions.some(
      (condition) => "source" in condition.metric && !!condition.metric.source,
    );
  for (const level of [...definition.buyLevels, ...definition.sellLevels]) {
    if (sourced(level.signal.conditions)) {
      gated.add(level.id);
    }
  }
  if (
    definition.finalExit &&
    definition.finalExit.rules.some((rule) => sourced(rule.signal.conditions))
  ) {
    gated.add(definition.finalExit.id);
  }
  return gated;
}

export class SourceCoverageAccumulator {
  private readonly tallies = new Map<string, ConditionTally>();
  private readonly tradesByStrategy = new Map<string, number>();
  private readonly gatedTradesByStrategy = new Map<string, number>();
  private cases = 0;

  constructor(
    private readonly set: QaMatrixStrategySet,
    private readonly fixtures: QaMatrixFixtures,
  ) {}

  /** Folds one completed case in. A case whose snapshot reads no ETF contributes trades only. */
  add(matrixCase: QaMatrixCase, evidence: RunEvidence): void {
    this.cases += 1;
    const strategyId = matrixCase.strategyId;
    this.tradesByStrategy.set(
      strategyId,
      (this.tradesByStrategy.get(strategyId) ?? 0) + evidence.trades.length,
    );
    if (!evidence.etf) {
      return;
    }
    const definition = evidence.snapshot.strategy
      .definition as unknown as StrategyDefinition;
    const gated = gatedLevelIds(definition);
    const gatedTrades = evidence.trades.filter(
      (trade) => trade.levelId !== null && gated.has(trade.levelId),
    ).length;
    this.gatedTradesByStrategy.set(
      strategyId,
      (this.gatedTradesByStrategy.get(strategyId) ?? 0) + gatedTrades,
    );
    for (const tally of tallySourcedConditions({
      strategyId,
      snapshot: evidence.snapshot,
      sessions: evidence.equity.map((row) => row.date),
      etf: evidence.etf,
    })) {
      const key = `${tally.strategyId}|${tally.conditionId}|${tally.fund}`;
      const total = this.tallies.get(key);
      if (!total) {
        this.tallies.set(key, { ...tally });
        continue;
      }
      total.TRUE += tally.TRUE;
      total.FALSE += tally.FALSE;
      total.NOT_EVALUABLE += tally.NOT_EVALUABLE;
      total.AMBIGUOUS += tally.AMBIGUOUS;
    }
  }

  /** The machine-readable evidence, for `summary.json`. */
  snapshot(): {
    cases: number;
    conditions: ConditionTally[];
    tradesByStrategy: Record<string, number>;
    gatedTradesByStrategy: Record<string, number>;
  } {
    return {
      cases: this.cases,
      conditions: [...this.tallies.values()],
      tradesByStrategy: Object.fromEntries(this.tradesByStrategy),
      gatedTradesByStrategy: Object.fromEntries(this.gatedTradesByStrategy),
    };
  }

  /**
   * The expectations of a **complete** sweep of the dimension. A selection (`--case`, `--golden`)
   * cannot be expected to reach every fund, so it is reported without expectations.
   */
  expectations(complete: boolean): SourceCoverageExpectation[] {
    if (!complete || (this.set !== "ETF" && this.set !== "SECTOR")) {
      return [];
    }
    const out: SourceCoverageExpectation[] = [];
    const byCondition = new Map<string, ConditionTally[]>();
    for (const tally of this.tallies.values()) {
      const key = `${tally.strategyId}|${tally.conditionId}`;
      byCondition.set(key, [...(byCondition.get(key) ?? []), tally]);
    }

    for (const strategy of this.fixtures.strategies) {
      const conditions = sourcedConditionsOf(strategy.definition);
      for (const [conditionId, condition] of conditions) {
        const rows = byCondition.get(`${strategy.id}|${conditionId}`) ?? [];
        const sum = (field: "TRUE" | "FALSE" | "NOT_EVALUABLE"): number =>
          rows.reduce((total, row) => total + row[field], 0);
        const probe = probeOf(condition);
        const label = `${strategy.id} ${conditionId}`;
        if (probe === "ALWAYS_TRUE") {
          out.push({
            expectation: `${label} is TRUE wherever evaluable`,
            met: sum("FALSE") === 0 && sum("TRUE") > 0,
            detail: `TRUE ${sum("TRUE")}, FALSE ${sum("FALSE")}`,
          });
        } else if (probe === "NEVER_TRUE") {
          out.push({
            expectation: `${label} is never TRUE`,
            met: sum("TRUE") === 0 && sum("FALSE") > 0,
            detail: `TRUE ${sum("TRUE")}, FALSE ${sum("FALSE")}`,
          });
        } else {
          out.push({
            expectation: `${label} was both TRUE and FALSE`,
            met: sum("TRUE") > 0 && sum("FALSE") > 0,
            detail: `TRUE ${sum("TRUE")}, FALSE ${sum("FALSE")}, NOT_EVALUABLE ${sum("NOT_EVALUABLE")}`,
          });
        }
      }
      if (conditions.size > 0) {
        const gatedTrades = this.gatedTradesByStrategy.get(strategy.id) ?? 0;
        const neverTrue = [...conditions.values()].some(
          (condition) => probeOf(condition) === "NEVER_TRUE",
        );
        out.push({
          expectation: neverTrue
            ? `${strategy.id} never traded through the level its never-TRUE Condition gates`
            : `${strategy.id} traded through a level its ETF Conditions gate`,
          // The never-TRUE probe's gated level must never trade; its other, un-gated levels may.
          met: neverTrue ? gatedTrades === 0 : gatedTrades > 0,
          detail: `${gatedTrades} gated trade(s), ${this.tradesByStrategy.get(strategy.id) ?? 0} trade(s) in all`,
        });
      }
    }

    const fundStats = new Map<
      string,
      { notEvaluable: number; reads: number }
    >();
    for (const tally of this.tallies.values()) {
      const stats = fundStats.get(tally.fund) ?? { notEvaluable: 0, reads: 0 };
      stats.notEvaluable += tally.NOT_EVALUABLE;
      stats.reads +=
        tally.TRUE + tally.FALSE + tally.NOT_EVALUABLE + tally.AMBIGUOUS;
      fundStats.set(tally.fund, stats);
    }
    for (const fund of YOUNGER_FUNDS) {
      const stats = fundStats.get(fund);
      if (stats) {
        out.push({
          expectation: `${fund} (lists inside the horizon) was NOT_EVALUABLE before it listed`,
          met: stats.notEvaluable > 0,
          detail: `${stats.notEvaluable} NOT_EVALUABLE of ${stats.reads} session read(s)`,
        });
      }
    }
    if (this.set === "SECTOR") {
      const unread = SECTOR_FUNDS.filter((fund) => !fundStats.has(fund));
      out.push({
        expectation: "Stock's Sector read all eleven sector funds",
        met: unread.length === 0,
        detail:
          unread.length === 0
            ? "all eleven read"
            : `never read: ${unread.join(", ")}`,
      });
    }
    return out;
  }
}

/** The case pairs a complete sweep of the dimension must find identical, in a stable order. */
export function metamorphicCasePairs(
  set: QaMatrixStrategySet,
  fixtures: QaMatrixFixtures,
): readonly { pair: string; control: string; probe: string }[] {
  const letter = set === "ETF" ? "E" : set === "SECTOR" ? "T" : null;
  if (letter === null) {
    return [];
  }
  const pairs: { pair: string; control: string; probe: string }[] = [];
  for (const entry of QA_MATRIX_METAMORPHIC_PAIRS) {
    if (!entry.control.startsWith(letter)) {
      continue;
    }
    const lists = entry.listIds ?? fixtures.lists.map((list) => list.id);
    for (const listId of lists) {
      for (const config of fixtures.configs) {
        pairs.push({
          pair: `${entry.control}≡${entry.probe}`,
          control: `${entry.control}-${listId}-${config.id}`,
          probe: `${entry.probe}-${listId}-${config.id}`,
        });
      }
    }
  }
  return pairs;
}
