import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  type OracleValuationReason,
} from "../oracle/valuation-ratios";
import { ComparisonTally } from "./compare";
import { generateHistory, type GeneratedHistory } from "./generator";
import { generateRestatementHistory } from "./generator-restatements";
import { productColumns, productTimeline } from "./production-adapter";

/**
 * The differential audit over generated histories: every session of every seed, every ratio, read
 * twice — as a backtest frame reads a closed session (its own statements) and as a Monitor's
 * provisional row reads one (the previous session's statements, the session's own price-basis
 * rules) — by the reference and by the product, and classified.
 *
 * Each seed gives one history of each family: the adversarial one (`generator.ts`) and one built
 * around a share-basis event and the provider's restatement of it (`generator-restatements.ts`).
 */
export const DIFFERENTIAL_FAMILIES = ["adversarial", "restatement"] as const;
export type DifferentialFamily = (typeof DIFFERENTIAL_FAMILIES)[number];

const GENERATORS: Record<
  DifferentialFamily,
  (seed: number) => GeneratedHistory
> = {
  adversarial: generateHistory,
  restatement: generateRestatementHistory,
};

export type DifferentialFamilyResult = {
  histories: number;
  sessions: number;
  tally: ComparisonTally;
  /** Available cells whose share count a measured re-base explained (rule 3's positive path). */
  explainedRestatementCells: number;
  /**
   * Cells whose share count rule 3 compared with an anchor beyond the revision just before it — that
   * one a restatement rule 3 withheld, or count-less (the review's G1 and G2 shapes, as ruled) —
   * available and withheld.
   */
  anchorBeyondPreviousAvailableCells: number;
  anchorBeyondPreviousWithheldCells: number;
  /** Cells rule 2 withheld because the walk had not yet confirmed its first level (G3, as ruled). */
  firstLevelUnconfirmedCells: number;
};

export type DifferentialResult = {
  seeds: number[];
  histories: number;
  sessions: number;
  tally: ComparisonTally;
  families: Map<DifferentialFamily, DifferentialFamilyResult>;
  /** Histories carrying each adversarial feature (the second family's prefixed `restatement:`). */
  features: Map<string, number>;
  /** Per rule: cells the rule alone withheld, across every history (a rule that never fires alone is unproven here). */
  soleRuleCells: Map<OracleValuationReason, number>;
};

export function runDifferential(
  seeds: readonly number[],
  options: {
    provisional?: boolean;
    keepFailures?: number;
    families?: readonly DifferentialFamily[];
  } = {},
): DifferentialResult {
  const tally = new ComparisonTally();
  const families = new Map<DifferentialFamily, DifferentialFamilyResult>();
  const features = new Map<string, number>();
  const soleRuleCells = new Map<OracleValuationReason, number>();
  let sessions = 0;
  let histories = 0;
  for (const family of options.families ?? DIFFERENTIAL_FAMILIES) {
    const result: DifferentialFamilyResult = {
      histories: 0,
      sessions: 0,
      tally: new ComparisonTally(),
      explainedRestatementCells: 0,
      anchorBeyondPreviousAvailableCells: 0,
      anchorBeyondPreviousWithheldCells: 0,
      firstLevelUnconfirmedCells: 0,
    };
    families.set(family, result);
    for (const seed of seeds) {
      const history = GENERATORS[family](seed);
      for (const feature of history.features) {
        const key =
          family === "adversarial" ? feature : `restatement:${feature}`;
        features.set(key, (features.get(key) ?? 0) + 1);
      }
      histories += 1;
      sessions += history.sessions.length;
      result.histories += 1;
      result.sessions += history.sessions.length;
      for (const provisional of options.provisional === false
        ? [false]
        : [false, true]) {
        compareHistory({
          history,
          tallies: [tally, result.tally],
          soleRuleCells,
          provisional,
          keepFailures: options.keepFailures,
          diagnostics: result,
        });
      }
    }
  }
  return {
    seeds: [...seeds],
    histories,
    sessions,
    tally,
    families,
    features,
    soleRuleCells,
  };
}

function compareHistory(input: {
  history: GeneratedHistory;
  tallies: readonly ComparisonTally[];
  soleRuleCells: Map<OracleValuationReason, number>;
  provisional: boolean;
  keepFailures: number | undefined;
  diagnostics: Pick<
    DifferentialFamilyResult,
    | "explainedRestatementCells"
    | "anchorBeyondPreviousAvailableCells"
    | "anchorBeyondPreviousWithheldCells"
    | "firstLevelUnconfirmedCells"
  >;
}): void {
  const { history, provisional } = input;
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
      for (const tally of input.tallies) {
        tally.record(
          `${history.features.includes("family-restatement") ? "restatement " : ""}seed ${history.seed}${provisional ? " provisional" : ""} ${session.date}`,
          ratio,
          product,
          outcome,
          input.keepFailures ?? 200,
        );
      }
      if (outcome.available) {
        const { terms } = outcome;
        input.diagnostics.explainedRestatementCells += Number(
          terms.explainedRestatement,
        );
        input.diagnostics.anchorBeyondPreviousAvailableCells += Number(
          terms.anchorBeyondPrevious,
        );
      } else {
        input.diagnostics.anchorBeyondPreviousWithheldCells += Number(
          outcome.anchorBeyondPrevious,
        );
        input.diagnostics.firstLevelUnconfirmedCells += Number(
          outcome.firstLevelUnconfirmed,
        );
      }
      if (!outcome.available && outcome.failing.length === 1) {
        input.soleRuleCells.set(
          outcome.reason,
          (input.soleRuleCells.get(outcome.reason) ?? 0) + 1,
        );
      }
    }
  });
}
