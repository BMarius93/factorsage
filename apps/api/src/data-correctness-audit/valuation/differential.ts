import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  type OracleValuationReason,
} from "../oracle/valuation-ratios";
import { ComparisonTally } from "./compare";
import { generateHistory, type GeneratedHistory } from "./generator";
import { productColumns, productTimeline } from "./production-adapter";

/**
 * The differential audit over generated histories: every session of every seed, every ratio, read
 * twice — as a backtest frame reads a closed session (its own statements) and as a Monitor's
 * provisional row reads one (the previous session's statements, the session's own price-basis
 * rules) — by the reference and by the product, and classified.
 */
export type DifferentialResult = {
  seeds: number[];
  histories: number;
  sessions: number;
  tally: ComparisonTally;
  /** Per adversarial feature: histories carrying it, and cells withheld only by each rule. */
  features: Map<string, number>;
  /** Per rule: cells the rule alone withheld, across every history (a rule that never fires alone is unproven here). */
  soleRuleCells: Map<OracleValuationReason, number>;
};

export function runDifferential(
  seeds: readonly number[],
  options: { provisional?: boolean; keepFailures?: number } = {},
): DifferentialResult {
  const tally = new ComparisonTally();
  const features = new Map<string, number>();
  const soleRuleCells = new Map<OracleValuationReason, number>();
  let sessions = 0;
  for (const seed of seeds) {
    const history = generateHistory(seed);
    for (const feature of history.features) {
      features.set(feature, (features.get(feature) ?? 0) + 1);
    }
    sessions += history.sessions.length;
    compareHistory(history, tally, soleRuleCells, false, options.keepFailures);
    if (options.provisional !== false) {
      compareHistory(history, tally, soleRuleCells, true, options.keepFailures);
    }
  }
  return {
    seeds: [...seeds],
    histories: seeds.length,
    sessions,
    tally,
    features,
    soleRuleCells,
  };
}

function compareHistory(
  history: GeneratedHistory,
  tally: ComparisonTally,
  soleRuleCells: Map<OracleValuationReason, number>,
  provisional: boolean,
  keepFailures = 200,
): void {
  const oracle = createValuationOracle(history.security);
  const timeline = productTimeline(history.security);
  const dates = history.sessions.map((session) => session.date);
  const closes = history.sessions.map((session) => session.close);
  const statementDateOf = provisional
    ? (index: number) => dates[Math.max(0, index - 1)] as string
    : undefined;
  const columns = productColumns({
    timeline,
    dates,
    closes,
    ratios: ORACLE_VALUATION_RATIO_IDS,
    ...(statementDateOf ? { statementDateOf } : {}),
  });
  history.sessions.forEach((session, index) => {
    const reading = oracle.reading(session.date, session.close, {
      ...(statementDateOf ? { statementDate: statementDateOf(index) } : {}),
    });
    for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
      const outcome = reading[ratio];
      const product = (columns.get(ratio) as Float64Array)[index] as number;
      tally.record(
        `seed ${history.seed}${provisional ? " provisional" : ""} ${session.date}`,
        ratio,
        product,
        outcome,
        keepFailures,
      );
      if (!outcome.available && outcome.failing.length === 1) {
        soleRuleCells.set(
          outcome.reason,
          (soleRuleCells.get(outcome.reason) ?? 0) + 1,
        );
      }
    }
  });
}
