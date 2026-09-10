import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import Decimal from "decimal.js";
import { ExecutionCalendar } from "@intrinsic/strategy";

/**
 * The validator's own decimal constructor, pinned like the engine's.
 *
 * Identities the ledger computes exactly are asserted here as exact equalities — `.eq()`, not
 * "within a budget". A budget is only used where a value is *reconstructed* from operands at
 * different declared scales, and then it is derived from those scales rather than chosen.
 */
const MONEY_SCALE = 6;
const PRICE_SCALE = 8;
const SHARES_SCALE = 10;
const V = Decimal.clone({
  precision: 50,
  rounding: 4,
  toExpNeg: -30,
  toExpPos: 40,
});
/** A persisted canonical value as an exact decimal. */
const d = (value: string | number | null | undefined): Decimal =>
  new V(value ?? 0);
/** A persisted canonical value as a number, for ratios, ordering and display only. */
const n = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Independent validation of one completed matrix run.
 *
 * Every check here re-derives a quantity from **persisted evidence** — the immutable snapshot, the
 * trades, the daily equity curve, the final positions, the summary and the pinned benchmark series
 * — and compares it with what the engine stored. Nothing calls the engine, imports its simulation
 * or replays its decisions: a validator that asked the same code the same question would agree with
 * every bug it exists to find.
 *
 * The distinction that matters is between *arithmetic* and *judgement*. Arithmetic is re-derivable:
 * whether a trade's amount equals shares times price, whether a SELL took the right fraction of the
 * shares remaining, whether the funded benchmark scenario reconciles from its own closes. Judgement
 * — whether a Signal was genuinely TRUE on the date it fired — depends on the evaluation frames the
 * day loop consumed, which are transient and exist nowhere in the database. Those invariants are
 * reported `NEEDS_ARCHIVE` rather than quietly asserted from a weaker proxy, and the runner proves
 * them for the golden combinations from the forensic archive instead.
 */

/**
 * `INDETERMINATE` is not a soft FAIL and not a quiet PASS.
 *
 * It means the persisted evidence genuinely cannot decide the question — not that the answer was
 * inconvenient. Turning a contradiction into a PASS through a wide tolerance is the failure this
 * status exists to make impossible: if the numbers disagree, that is a FAIL, and if the
 * representation cannot answer, that is INDETERMINATE and it is reported as such.
 */
export type InvariantStatus =
  "PASS" | "FAIL" | "INDETERMINATE" | "NEEDS_ARCHIVE" | "NOT_APPLICABLE";

export type InvariantResult = {
  /** 1..40, matching the matrix specification, so a report is comparable across sweeps. */
  readonly id: number;
  readonly key: string;
  readonly title: string;
  readonly status: InvariantStatus;
  readonly detail: string;
  readonly violations?: readonly string[];
};

/**
 * The last representable unit at each declared scale.
 *
 * These are not tolerances. They are the width of the storage format — the smallest difference the
 * database can hold — and the only thing that makes a gap between two persisted values genuinely
 * unresolvable rather than wrong. At money scale six, `0.000001` is a real disagreement and there
 * is nothing smaller for it to be.
 */
const MONEY_ULP = new V(10).pow(-MONEY_SCALE);
const SHARES_ULP = new V(10).pow(-SHARES_SCALE);

/** Rounds to the money scale exactly as the engine and PostgreSQL `numeric` both do. */
const money = (value: Decimal): Decimal =>
  value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
/** Rounds to the price scale. */
const price = (value: Decimal): Decimal =>
  value.toDecimalPlaces(PRICE_SCALE, Decimal.ROUND_HALF_UP);
/** Truncates to the share scale, downward, exactly as every share quantity is derived. */
const sharesDown = (value: Decimal): Decimal =>
  value.toDecimalPlaces(SHARES_SCALE, Decimal.ROUND_DOWN);

/**
 * Half the spacing of float64 at a given magnitude, in that magnitude's own units.
 *
 * There is exactly one place the engine is deliberately not exact: the **sizing** decision, which
 * chooses a target and is reconciled against nothing, computes `portfolioValue` as
 * `toNumber(cash) + toNumber(positionsValue)`. That conversion is lossy at the magnitudes this
 * matrix reaches — `334310721745.960000` needs eighteen significant digits and float64 carries
 * fifteen and a bit — so invariant 18 is the one check that cannot be an equality.
 *
 * This is what that costs, computed from the representation rather than chosen: 2^-53 per
 * operation, times the magnitude, times the number of operations on the path. Nothing else in this
 * file is allowed to use it.
 */
const FLOAT64_HALF_ULP = Number.EPSILON / 2;
const float64Slack = (
  magnitude: Decimal | number,
  operations: number,
): Decimal => new V(magnitude).abs().times(FLOAT64_HALF_ULP).times(operations);

/** Within a budget that some caller derived. Never a constant, never relative to portfolio size. */
const within = (actual: Decimal, expected: Decimal, budget: Decimal): boolean =>
  actual.minus(expected).abs().lte(budget);

const VIOLATION_CAP = 8;

function report(
  id: number,
  key: string,
  title: string,
  violations: readonly string[],
  passDetail: string,
): InvariantResult {
  if (violations.length === 0) {
    return { id, key, title, status: "PASS", detail: passDetail };
  }
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

function archive(
  id: number,
  key: string,
  title: string,
  detail: string,
): InvariantResult {
  return { id, key, title, status: "NEEDS_ARCHIVE", detail };
}

/**
 * Persisted values, as canonical decimal strings.
 *
 * The validator's job is to check equalities the database holds exactly, so it reads the stored
 * digits rather than a float64 rendering of them. At C08 magnitudes the difference is the whole
 * question: a $334bn portfolio is 18 significant digits and float64 carries about 15.95.
 */
export type EvidenceTrade = {
  readonly sequence: number;
  readonly date: string;
  readonly securityId: string;
  readonly symbol: string;
  readonly action: "BUY" | "SELL" | "FINAL_EXIT";
  readonly levelId: string | null;
  readonly levelPercentage: number | null;
  readonly shares: string;
  readonly price: string;
  readonly amount: string;
  readonly fees: string;
  readonly realizedPnl: string | null;
  readonly cashAfter: string;
  readonly sharesAfter: string;
  readonly averageCostAfter: string | null;
};

export type EvidenceEquity = {
  readonly date: string;
  readonly cash: string;
  readonly positionsValue: string;
  readonly totalValue: string;
  readonly investedCapital: string;
  readonly benchmarkValue: string | null;
  readonly cashBaselineValue: string;
  readonly openPositions: number;
};

export type EvidencePosition = {
  readonly securityId: string;
  readonly symbol: string;
  readonly openedDate: string;
  readonly shares: string;
  readonly averageCost: string;
  readonly lastPrice: string;
  readonly marketValue: string;
  readonly unrealizedPnl: string;
};

export type EvidenceSummary = {
  readonly firstSimulatedDate: string;
  readonly lastSimulatedDate: string;
  readonly tradingDays: number;
  readonly investedCapital: string;
  readonly finalCash: string;
  readonly finalPositionsValue: string;
  readonly finalValue: string;
  readonly netProfit: string;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string;
  readonly totalTrades: number;
  readonly buyTrades: number;
  readonly sellTrades: number;
  readonly finalExitTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly openPositions: number;
};

export type RunEvidence = {
  readonly runId: string;
  readonly caseId: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly failurePhase: string | null;
  readonly snapshot: BacktestRunSnapshot;
  readonly startDate: string;
  readonly endDate: string;
  readonly initialCapital: string;
  readonly monthlyContribution: string;
  readonly maximumPositions: number;
  readonly summary: EvidenceSummary | null;
  readonly equity: readonly EvidenceEquity[];
  readonly trades: readonly EvidenceTrade[];
  readonly positions: readonly EvidencePosition[];
  /** Every date of the pinned execution-calendar series, ascending. */
  readonly executionCalendarDates: readonly string[];
  /** The pinned comparison series' closes, ascending. */
  readonly benchmarkCloses: readonly {
    readonly date: string;
    readonly close: string;
  }[];
  /** First canonical price date per security, for the pre-listing check. */
  readonly firstPriceDateBySecurityId: ReadonlyMap<string, string>;
};

/**
 * The engine's buy-window predicate, re-derived from the snapshot's normalized ranges.
 *
 * `FULL` admits every date; `CUSTOM` admits a date inside any range, with an open-ended range
 * running to the end of the run. Boundaries are inclusive on both sides, which is what makes the
 * `L10` single-session windows a real boundary test rather than a rounding one.
 */
function buyWindowAdmits(
  security: BacktestRunSnapshot["securities"][number],
  date: string,
): boolean {
  if (security.buyWindowMode === "FULL") {
    return true;
  }
  return security.buyWindows.some(
    (range) =>
      date >= range.startDate &&
      (range.endDate === null || date <= range.endDate),
  );
}

/**
 * Validates every invariant that persisted evidence can settle.
 *
 * A failed run is not run through the financial checks: they would all fail for one reason, burying
 * the reason. It is reported as the single failure it is.
 */
export function validateRunInvariants(
  evidence: RunEvidence,
): readonly InvariantResult[] {
  const results: InvariantResult[] = [];

  results.push(
    report(
      1,
      "completed",
      "Run reaches COMPLETED",
      evidence.status === "COMPLETED"
        ? []
        : [`Run status is ${evidence.status}.`],
      "COMPLETED",
    ),
  );

  const failureNotes: string[] = [];
  if (evidence.failureCode) {
    failureNotes.push(`failureCode=${evidence.failureCode}`);
  }
  if (evidence.failurePhase) {
    failureNotes.push(`failurePhase=${evidence.failurePhase}`);
  }
  if (evidence.failureMessage) {
    failureNotes.push(`failureMessage=${evidence.failureMessage}`);
  }
  results.push(
    report(
      2,
      "no-failure-metadata",
      "No FAILED phase or failure metadata",
      failureNotes,
      "no failure metadata recorded",
    ),
  );

  if (evidence.status !== "COMPLETED") {
    // Every remaining invariant reads a result that does not exist. Reporting forty derived
    // failures would obscure the one that happened.
    for (const pending of PENDING_INVARIANTS) {
      results.push({
        ...pending,
        status: "NOT_APPLICABLE",
        detail: `run did not complete (${evidence.status})`,
      });
    }
    return results;
  }

  const { equity, trades } = evidence;
  const calendar = ExecutionCalendar.restricted(
    evidence.startDate,
    evidence.endDate,
    evidence.executionCalendarDates,
  );

  // Needed by invariant 6 as well as 14-17, so it is derived before the first check that reads it.
  const contributionDates = contributionDatesOf(calendar);

  results.push(checkExecutionDates(evidence, calendar));
  results.push(checkNoDuplicateEquityDates(equity));
  results.push(checkEquityOrdered(equity));
  results.push(checkCashLedger(evidence, contributionDates));
  results.push(checkPositionCap(evidence));
  results.push(checkOneSlotPerSymbol(evidence));
  results.push(checkEquityIdentity(equity));
  results.push(checkTradeAmount(trades));

  const bySecurity = new Map(
    evidence.snapshot.securities.map((entry) => [entry.securityId, entry]),
  );
  results.push(checkBuyWindows(evidence, bySecurity));
  results.push(checkSellsUnrestricted(evidence, bySecurity, 12, "sell"));
  results.push(checkSellsUnrestricted(evidence, bySecurity, 13, "final-exit"));

  results.push(checkContributionDates(evidence, contributionDates));
  results.push(checkCashBaseline(evidence, contributionDates));
  results.push(checkBenchmarkContributions(evidence, contributionDates));
  results.push(checkBenchmarkScenario(evidence, contributionDates));

  const lifecycles = buildLifecycles(trades);
  results.push(checkBuySizing(evidence, lifecycles));
  results.push(checkStrongestLevel(evidence));
  results.push(checkSettledLevels(evidence, lifecycles, contributionDates));
  results.push(
    checkContributionTopUps(
      evidence,
      lifecycles,
      contributionDates,
      bySecurity,
    ),
  );
  results.push(checkNoRebalance(evidence, lifecycles, contributionDates));
  results.push(checkSellFraction(trades));
  results.push(checkSellLevelOnce(lifecycles));
  results.push(checkFinalExitCloses(trades));
  results.push(checkNoSameDateReentry(trades));
  results.push(checkPartialSellThenBuy(trades));
  // One walk of the trade log rebuilds the cost state the engine carried, for all three of the
  // checks that need it.
  const costSteps = walkCostLedger(trades);
  results.push(checkAverageCost(trades, costSteps));
  results.push(checkRealizedPnl(evidence, costSteps));
  results.push(
    checkUnrealizedPnl(evidence, finalCostStates(costSteps, trades)),
  );
  results.push(checkFinalPositions(evidence));
  results.push(checkSummaryFinalValue(evidence));
  results.push(checkInvestedCapital(evidence, contributionDates));
  results.push(checkTradeCounts(evidence));
  results.push(checkPositionCount(evidence));

  results.push(
    archive(
      36,
      "trade-signal-evidence",
      "Every trade maps to a level whose Signal was TRUE in the consumed frame",
      "The evaluation frames the day loop consumed are released at the end of each calendar-year " +
        "window and are persisted nowhere, so this cannot be settled from the database. Proven " +
        "from the forensic archive for the golden combinations.",
    ),
  );
  results.push(
    archive(
      37,
      "trigger-previous-row",
      "Trigger previous-row semantics across annual windows",
      "The row retained across a year boundary for `t - 1` is never persisted. Proven from the " +
        "archive's `execution/checkpoints.ndjson` and the spliced context row in each frame.",
    ),
  );
  results.push(checkBuyWindowBoundaries(evidence, bySecurity, calendar));
  results.push(checkNoPreListingTrades(evidence));
  results.push(checkNoWarmupDates(evidence, calendar));

  return results;
}

/** Titles for invariants that are skipped wholesale when a run did not complete. */
const PENDING_INVARIANTS: readonly Omit<
  InvariantResult,
  "status" | "detail"
>[] = [
  {
    id: 3,
    key: "execution-dates",
    title: "Canonical execution dates respected",
  },
  { id: 4, key: "equity-unique", title: "No duplicate equity dates" },
  { id: 5, key: "equity-ordered", title: "Equity dates ordered" },
  { id: 6, key: "cash-non-negative", title: "Strategy cash >= 0" },
  { id: 7, key: "position-cap", title: "Open positions <= maximumPositions" },
  {
    id: 8,
    key: "one-slot-per-symbol",
    title: "One symbol occupies at most one slot",
  },
  {
    id: 9,
    key: "equity-identity",
    title: "cash + positionsValue == totalValue",
  },
  { id: 10, key: "trade-amount", title: "amount == shares x price" },
  { id: 11, key: "buy-window", title: "BUY only inside the buy window" },
  {
    id: 12,
    key: "sell-unrestricted",
    title: "SELL may occur outside the buy window",
  },
  {
    id: 13,
    key: "final-exit-unrestricted",
    title: "FINAL EXIT may occur outside the buy window",
  },
  {
    id: 14,
    key: "contribution-dates",
    title: "Contribution dates match the schedule",
  },
  {
    id: 15,
    key: "cash-baseline",
    title: "cashBaselineValue equals cumulative contributions",
  },
  {
    id: 16,
    key: "benchmark-contributions",
    title: "Benchmark scenario uses the same contributions",
  },
  {
    id: 17,
    key: "benchmark-reconciles",
    title: "Benchmark shares/value reconcile from benchmark prices",
  },
  {
    id: 18,
    key: "buy-sizing",
    title: "BUY sizing matches the target/shortfall formula",
  },
  { id: 19, key: "strongest-level", title: "Strongest eligible BUY level" },
  {
    id: 20,
    key: "settled-levels",
    title: "Settled BUY levels follow lifecycle rules",
  },
  {
    id: 21,
    key: "contribution-top-up",
    title: "Contribution-day top-up only when eligible",
  },
  { id: 22, key: "no-rebalance", title: "No general rebalance" },
  {
    id: 23,
    key: "sell-fraction",
    title: "SELL percentage applied to remaining shares",
  },
  {
    id: 24,
    key: "sell-once",
    title: "SELL level fires at most once per lifecycle",
  },
  {
    id: 25,
    key: "final-exit-closes",
    title: "FINAL EXIT closes the remaining position",
  },
  {
    id: 26,
    key: "no-same-date-reentry",
    title: "No same-date re-entry after FINAL EXIT",
  },
  {
    id: 27,
    key: "partial-sell-then-buy",
    title: "Partial SELL then eligible BUY on the same date",
  },
  { id: 28, key: "average-cost", title: "Average-cost basis reconciles" },
  { id: 29, key: "realized-pnl", title: "Realized P&L reconciles" },
  { id: 30, key: "unrealized-pnl", title: "Unrealized P&L reconciles" },
  {
    id: 31,
    key: "final-positions",
    title: "Final positions reconcile with the last equity state",
  },
  {
    id: 32,
    key: "summary-final-value",
    title: "Summary final value reconciles",
  },
  { id: 33, key: "invested-capital", title: "Invested capital reconciles" },
  { id: 34, key: "trade-counts", title: "Trade counts reconcile" },
  { id: 35, key: "position-count", title: "Position count reconciles" },
  {
    id: 36,
    key: "trade-signal-evidence",
    title: "Every trade maps to a TRUE Signal",
  },
  {
    id: 37,
    key: "trigger-previous-row",
    title: "Trigger previous-row semantics",
  },
  {
    id: 38,
    key: "buy-window-boundaries",
    title: "Buy-window boundary inclusion",
  },
  { id: 39, key: "no-pre-listing-trades", title: "No trading before listing" },
  { id: 40, key: "no-warmup-dates", title: "No warm-up date is simulated" },
];

function checkExecutionDates(
  evidence: RunEvidence,
  calendar: ExecutionCalendar,
): InvariantResult {
  const violations: string[] = [];
  const expected = calendar.dates;
  const actual = evidence.equity.map((point) => point.date);
  if (expected.length !== actual.length) {
    violations.push(
      `The run has ${actual.length} equity rows but the pinned calendar restricted to ` +
        `${evidence.startDate}..${evidence.endDate} holds ${expected.length} sessions.`,
    );
  }
  const expectedSet = new Set(expected);
  for (const date of actual) {
    if (!expectedSet.has(date)) {
      violations.push(
        `${date} is not an execution date of the pinned calendar.`,
      );
      if (violations.length > 20) {
        break;
      }
    }
  }
  const actualSet = new Set(actual);
  for (const date of expected) {
    if (!actualSet.has(date)) {
      violations.push(`${date} is an execution date with no equity row.`);
      if (violations.length > 20) {
        break;
      }
    }
  }
  return report(
    3,
    "execution-dates",
    "Canonical execution dates respected",
    violations,
    `${actual.length} equity rows, exactly the pinned calendar's sessions in the period`,
  );
}

function checkNoDuplicateEquityDates(
  equity: readonly EvidenceEquity[],
): InvariantResult {
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const point of equity) {
    if (seen.has(point.date)) {
      violations.push(`${point.date} appears more than once.`);
    }
    seen.add(point.date);
  }
  return report(
    4,
    "equity-unique",
    "No duplicate equity dates",
    violations,
    `${equity.length} distinct dates`,
  );
}

function checkEquityOrdered(
  equity: readonly EvidenceEquity[],
): InvariantResult {
  const violations: string[] = [];
  for (let index = 1; index < equity.length; index += 1) {
    const previous = equity[index - 1] as EvidenceEquity;
    const current = equity[index] as EvidenceEquity;
    if (current.date <= previous.date) {
      violations.push(`${previous.date} is followed by ${current.date}.`);
    }
  }
  return report(
    5,
    "equity-ordered",
    "Equity dates ordered",
    violations,
    "strictly ascending",
  );
}

/**
 * The cash ledger, rebuilt movement by movement, and the floor it may never breach.
 *
 * Every mutation is exact at money scale six: the balance opens at `initialCapital`, rises by one
 * contribution on each funded session, falls by a BUY's persisted `amount` and rises by an exit's.
 * So the balance after any trade, and at the close of any date, is a value the persisted evidence
 * determines completely — which is why this is an equality with no budget at all. A millionth of a
 * dollar that the run cannot account for is a millionth of a dollar that came from somewhere.
 *
 * Non-negativity is the same statement read from below. The engine caps every purchase at the cash
 * actually available and then retreats a share-ulp at a time until the amount fits, so a balance of
 * `-0.000001` would mean that cap failed. The check used to allow two cents of overdraft.
 *
 * A row that disagrees is reported once and the ledger then follows what was persisted, so a single
 * bad movement does not condemn every trade after it.
 */
function checkCashLedger(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  const violations: string[] = [];
  const funded = new Set(contributionDates);
  const contribution = money(d(evidence.monthlyContribution));
  let cash = money(d(evidence.initialCapital));
  let tradeIndex = 0;

  for (const point of evidence.equity) {
    if (funded.has(point.date)) {
      cash = money(cash.plus(contribution));
    }
    while (
      tradeIndex < evidence.trades.length &&
      (evidence.trades[tradeIndex] as EvidenceTrade).date === point.date
    ) {
      const trade = evidence.trades[tradeIndex] as EvidenceTrade;
      // V1 charges no fees, and invariant 10 proves it; cash therefore moves by exactly the amount
      // the trade row records, in the direction the action implies.
      cash =
        trade.action === "BUY"
          ? money(cash.minus(d(trade.amount)))
          : money(cash.plus(d(trade.amount)));
      if (!d(trade.cashAfter).eq(cash)) {
        violations.push(
          `#${trade.sequence} ${trade.symbol} ${trade.action} ${trade.date}: cashAfter ` +
            `${trade.cashAfter} but the ledger reaches ${cash.toFixed(MONEY_SCALE)}.`,
        );
        cash = d(trade.cashAfter);
      }
      tradeIndex += 1;
    }
    if (!d(point.cash).eq(cash)) {
      violations.push(
        `${point.date}: equity cash ${point.cash} but the ledger reaches ${cash.toFixed(MONEY_SCALE)}.`,
      );
      cash = d(point.cash);
    }
    if (d(point.cash).isNegative()) {
      violations.push(`${point.date}: cash ${point.cash} is negative.`);
    }
    if (violations.length > 10) {
      break;
    }
  }
  if (violations.length <= 10 && tradeIndex < evidence.trades.length) {
    const orphan = evidence.trades[tradeIndex] as EvidenceTrade;
    violations.push(
      `#${orphan.sequence} executed on ${orphan.date}, for which no equity row exists.`,
    );
  }

  return report(
    6,
    "cash-non-negative",
    "Cash ledger reconciles exactly and never goes negative",
    violations,
    `${evidence.trades.length} cash movements reconcile to ${cash.toFixed(MONEY_SCALE)} across ` +
      `${evidence.equity.length} sessions, never negative`,
  );
}

function checkPositionCap(evidence: RunEvidence): InvariantResult {
  const violations = evidence.equity
    .filter((point) => point.openPositions > evidence.maximumPositions)
    .map(
      (point) =>
        `${point.date}: ${point.openPositions} open positions exceeds maximumPositions=${evidence.maximumPositions}`,
    );
  return report(
    7,
    "position-cap",
    "Open positions <= maximumPositions",
    violations,
    `never more than ${evidence.maximumPositions} concurrent positions`,
  );
}

/**
 * That a symbol never occupies two slots.
 *
 * Replayed from the trade sequence rather than read off the final positions: the schema's unique
 * `(runId, securityId)` already makes two *final* rows impossible, so the only place a duplicate
 * slot could exist is inside the run. The count of symbols holding shares must equal the day's
 * `openPositions`, on every date, which is the same statement made once per session.
 */
function checkOneSlotPerSymbol(evidence: RunEvidence): InvariantResult {
  const violations: string[] = [];
  const shares = new Map<string, number>();
  const equityByDate = new Map(
    evidence.equity.map((point) => [point.date, point]),
  );
  const dates = evidence.equity.map((point) => point.date);
  let tradeIndex = 0;

  for (const date of dates) {
    while (
      tradeIndex < evidence.trades.length &&
      (evidence.trades[tradeIndex] as EvidenceTrade).date === date
    ) {
      const trade = evidence.trades[tradeIndex] as EvidenceTrade;
      shares.set(trade.securityId, n(trade.sharesAfter));
      tradeIndex += 1;
    }
    const held = [...shares.entries()].filter(([, value]) => value > 1e-12);
    const point = equityByDate.get(date) as EvidenceEquity;
    if (held.length !== point.openPositions) {
      violations.push(
        `${date}: ${held.length} symbols hold shares but the equity row records ${point.openPositions} open positions.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  return report(
    8,
    "one-slot-per-symbol",
    "One symbol occupies at most one slot",
    violations,
    "held symbols equal the recorded open-position count on every date",
  );
}

function checkEquityIdentity(
  equity: readonly EvidenceEquity[],
): InvariantResult {
  const violations: string[] = [];
  for (const point of equity) {
    // Exact, not "within a budget": all three are stored at the same scale and the engine wrote
    // them from one quantized sum. A tolerance here would be a loophole, not a budget.
    const expected = d(point.cash).plus(d(point.positionsValue));
    if (!d(point.totalValue).eq(expected)) {
      violations.push(
        `${point.date}: cash ${point.cash} + positions ${point.positionsValue} = ` +
          `${expected.toFixed(6)} but totalValue is ${point.totalValue}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  return report(
    9,
    "equity-identity",
    "cash + positionsValue == totalValue",
    violations,
    `identity holds on all ${equity.length} dates`,
  );
}

function checkTradeAmount(trades: readonly EvidenceTrade[]): InvariantResult {
  const violations: string[] = [];
  for (const trade of trades) {
    // The persisted amount must equal the quantized product of the persisted shares and price —
    // exactly. The engine derives it that way, so anything else is a real disagreement.
    const expected = d(trade.shares)
      .times(d(trade.price))
      .toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
    if (!d(trade.amount).eq(expected)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.action} ${trade.date}: ${trade.shares} x ` +
          `${trade.price} = ${expected.toFixed(6)} but amount is ${trade.amount}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
    if (!d(trade.fees).isZero()) {
      violations.push(
        `#${trade.sequence} carries fees ${n(trade.fees)}; V1 methodology is zero fees and zero slippage.`,
      );
    }
  }
  return report(
    10,
    "trade-amount",
    "amount == shares x price",
    violations,
    `${trades.length} trades reconcile at zero fees`,
  );
}

function checkBuyWindows(
  evidence: RunEvidence,
  bySecurity: ReadonlyMap<string, BacktestRunSnapshot["securities"][number]>,
): InvariantResult {
  const violations: string[] = [];
  for (const trade of evidence.trades) {
    if (trade.action !== "BUY") {
      continue;
    }
    const security = bySecurity.get(trade.securityId);
    if (!security) {
      violations.push(
        `#${trade.sequence} ${trade.symbol}: the snapshot has no such security.`,
      );
      continue;
    }
    if (!buyWindowAdmits(security, trade.date)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} BUY on ${trade.date} is outside its buy window ` +
          `[${security.buyWindows
            .map((range) => `${range.startDate}..${range.endDate ?? "open"}`)
            .join(", ")}].`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  const buys = evidence.trades.filter((trade) => trade.action === "BUY").length;
  return report(
    11,
    "buy-window",
    "BUY only inside the buy window",
    violations,
    `all ${buys} BUYs inside their security's window`,
  );
}

/**
 * That selling is never restricted by a buy window.
 *
 * There is nothing to fail here: a SELL outside a window is *correct*, and the check exists to
 * record that the engine actually does it rather than to police it. It reports how many exits
 * happened outside a window, which is the evidence that the rule is exercised at all — a matrix in
 * which that count is zero for every run has not tested the rule.
 */
function checkSellsUnrestricted(
  evidence: RunEvidence,
  bySecurity: ReadonlyMap<string, BacktestRunSnapshot["securities"][number]>,
  id: number,
  kind: "sell" | "final-exit",
): InvariantResult {
  const action = kind === "sell" ? "SELL" : "FINAL_EXIT";
  const relevant = evidence.trades.filter((trade) => trade.action === action);
  const outside = relevant.filter((trade) => {
    const security = bySecurity.get(trade.securityId);
    return security ? !buyWindowAdmits(security, trade.date) : false;
  });
  return {
    id,
    key: kind === "sell" ? "sell-unrestricted" : "final-exit-unrestricted",
    title:
      kind === "sell"
        ? "SELL may occur outside the buy window"
        : "FINAL EXIT may occur outside the buy window",
    status: "PASS",
    detail: `${outside.length} of ${relevant.length} ${action} trades executed outside a buy window, which is permitted`,
  };
}

/**
 * The contribution schedule, re-derived from the calendar.
 *
 * `first-eligible-trading-day-of-month@1`: the first simulated date receives the initial capital and
 * no contribution, and every later calendar month contributes on its first simulated session.
 */
function contributionDatesOf(calendar: ExecutionCalendar): readonly string[] {
  const dates: string[] = [];
  let previousMonth: string | null = null;
  calendar.dates.forEach((date, index) => {
    const month = date.slice(0, 7);
    if (month !== previousMonth) {
      previousMonth = month;
      if (index > 0) {
        dates.push(date);
      }
    }
  });
  return dates;
}

function checkContributionDates(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  if (d(evidence.monthlyContribution).isZero()) {
    const moved = evidence.equity.filter(
      (point, index) =>
        index > 0 &&
        !d(point.cashBaselineValue).eq(
          d((evidence.equity[index - 1] as EvidenceEquity).cashBaselineValue),
        ),
    );
    return report(
      14,
      "contribution-dates",
      "Contribution dates match the schedule",
      moved.map(
        (point) =>
          `${point.date}: the cash baseline moved although this configuration contributes nothing.`,
      ),
      "no contributions configured and none applied",
    );
  }

  const violations: string[] = [];
  const expected = new Set(contributionDates);
  for (let index = 1; index < evidence.equity.length; index += 1) {
    const previous = evidence.equity[index - 1] as EvidenceEquity;
    const current = evidence.equity[index] as EvidenceEquity;
    // The baseline is a scale-six accumulation of scale-six deposits, so the difference between
    // two consecutive rows *is* the deposit — exactly, with nothing left over to tolerate.
    const delta = d(current.cashBaselineValue).minus(
      d(previous.cashBaselineValue),
    );
    const deposited = delta.gt(0);
    if (deposited && !expected.has(current.date)) {
      violations.push(
        `${current.date} deposited ${delta.toFixed(MONEY_SCALE)} but is not the first simulated session of its month.`,
      );
    }
    if (!deposited && expected.has(current.date)) {
      violations.push(
        `${current.date} is the first simulated session of its month but deposited nothing.`,
      );
    }
    if (deposited && !delta.eq(d(evidence.monthlyContribution))) {
      violations.push(
        `${current.date} deposited ${delta.toFixed(MONEY_SCALE)} instead of ${evidence.monthlyContribution}.`,
      );
    }
    if (delta.isNegative()) {
      violations.push(
        `${current.date}: the cash baseline fell by ${delta.abs().toFixed(MONEY_SCALE)}; external capital is never withdrawn.`,
      );
    }
    if (violations.length > 10) {
      break;
    }
  }
  return report(
    14,
    "contribution-dates",
    "Contribution dates match the schedule",
    violations,
    `${contributionDates.length} deposits, each on its month's first simulated session`,
  );
}

function checkCashBaseline(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  const violations: string[] = [];
  const contributionSet = new Set(contributionDates);
  let deposits = 0;
  for (const point of evidence.equity) {
    if (contributionSet.has(point.date)) {
      deposits += 1;
    }
    const expected = d(evidence.initialCapital)
      .plus(d(evidence.monthlyContribution).times(deposits))
      .toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
    if (!d(point.cashBaselineValue).eq(expected)) {
      violations.push(
        `${point.date}: cashBaselineValue ${point.cashBaselineValue} but ` +
          `${evidence.initialCapital} + ${deposits} x ${evidence.monthlyContribution} = ${expected.toFixed(6)}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  return report(
    15,
    "cash-baseline",
    "cashBaselineValue equals cumulative external contributions",
    violations,
    `baseline reaches ${(
      n(evidence.initialCapital) +
      contributionDates.length * n(evidence.monthlyContribution)
    ).toFixed(2)} from ${contributionDates.length} deposits`,
  );
}

/**
 * That the benchmark scenario received the same external cash on the same dates.
 *
 * The whole point of the three funded scenarios is that a gap between them is a difference in what
 * the money did, never in how much of it there was — so this is checked against the funding
 * schedule directly, and invariant 17 then proves the value that schedule produced.
 */
function checkBenchmarkContributions(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  const priced = evidence.equity.filter(
    (point) => point.benchmarkValue !== null,
  );
  if (priced.length === 0) {
    return {
      id: 16,
      key: "benchmark-contributions",
      title: "Benchmark scenario uses the same contributions",
      status: "NOT_APPLICABLE",
      detail: "the run recorded no absolute benchmark values",
    };
  }
  const reconstructed = reconstructBenchmarkScenario(
    evidence,
    contributionDates,
  );
  const violations = reconstructed.fundingMismatch;
  return report(
    16,
    "benchmark-contributions",
    "Benchmark scenario uses the same contributions",
    violations,
    `${contributionDates.length} deposits applied to the benchmark on the same dates`,
  );
}

/**
 * Independently rebuilds the funded benchmark scenario from the pinned series' own closes.
 *
 * A funded portfolio, not a scaled index: external capital buys benchmark shares at the close in
 * effect on the date it arrives — the series' own close, or the most recent one before it under the
 * carry-forward rule — and the whole holding is then marked to that close. The difference from a
 * scaled index is invisible until a run has contributions, which is why this is reconciled rather
 * than assumed.
 *
 * Rebuilt in decimal at the engine's own declared scales, because the point of the check is to be
 * able to say that a difference of one millionth of a dollar is a difference. Two share quantities
 * that both round down to ten decimals agree exactly; two that do not, do not.
 */
function reconstructBenchmarkScenario(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): {
  readonly values: ReadonlyMap<string, Decimal | null>;
  readonly fundingMismatch: readonly string[];
} {
  const closes = new Map(
    evidence.benchmarkCloses.map((bar) => [bar.date, d(bar.close)]),
  );
  const barDates = evidence.benchmarkCloses.map((bar) => bar.date);
  const contributionSet = new Set(contributionDates);
  const values = new Map<string, Decimal | null>();
  const fundingMismatch: string[] = [];

  let shares = new V(0);
  let pending = new V(0);
  let lastClose: Decimal | null = null;
  let barIndex = 0;
  let funded = false;

  for (const point of evidence.equity) {
    while (
      barIndex < barDates.length &&
      (barDates[barIndex] as string) <= point.date
    ) {
      lastClose = closes.get(barDates[barIndex] as string) ?? null;
      barIndex += 1;
    }
    const cashIn = !funded
      ? d(evidence.initialCapital)
      : contributionSet.has(point.date)
        ? d(evidence.monthlyContribution)
        : new V(0);
    funded = true;
    if (cashIn.gt(0)) {
      pending = money(pending.plus(cashIn));
    }
    if (lastClose === null) {
      values.set(point.date, null);
      continue;
    }
    const mark = price(lastClose);
    if (pending.gt(0) && mark.gt(0)) {
      // Truncated to the share scale, exactly as the engine quantizes every share quantity.
      shares = shares.plus(sharesDown(pending.div(mark)));
      pending = new V(0);
    }
    values.set(point.date, money(shares.times(mark)));
  }
  if (pending.gt(0)) {
    fundingMismatch.push(
      `${pending.toFixed(MONEY_SCALE)} of external capital never met a benchmark close and was never invested.`,
    );
  }
  return { values, fundingMismatch };
}

function checkBenchmarkScenario(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  const priced = evidence.equity.filter(
    (point) => point.benchmarkValue !== null,
  );
  if (priced.length === 0) {
    return {
      id: 17,
      key: "benchmark-reconciles",
      title: "Benchmark shares/value reconcile from benchmark prices",
      status: "NOT_APPLICABLE",
      detail: "the run recorded no absolute benchmark values",
    };
  }
  const { values } = reconstructBenchmarkScenario(evidence, contributionDates);
  const violations: string[] = [];
  for (const point of evidence.equity) {
    if (point.benchmarkValue === null) {
      continue;
    }
    const expected = values.get(point.date);
    if (expected === undefined || expected === null) {
      violations.push(
        `${point.date}: the run recorded a benchmark value but the pinned series has no close in effect.`,
      );
    } else if (!d(point.benchmarkValue).eq(expected)) {
      // Exact: both sides are a decimal share count truncated to ten places, marked at a close
      // rounded to eight, quantized to six. A cent of slack here — let alone the 1e-7 of portfolio
      // value this used to allow, which is $33,431 on the largest run in the matrix — would hide
      // the whole class of defect the check exists for.
      violations.push(
        `${point.date}: benchmarkValue ${point.benchmarkValue} but an independent funded ` +
          `reconstruction gives ${expected.toFixed(MONEY_SCALE)}.`,
      );
    }
    if (violations.length > 10) {
      break;
    }
  }
  return report(
    17,
    "benchmark-reconciles",
    "Benchmark shares/value reconcile from benchmark prices",
    violations,
    `${priced.length} benchmark values reconcile from accumulated fractional shares`,
  );
}

type Lifecycle = {
  readonly securityId: string;
  readonly symbol: string;
  readonly trades: EvidenceTrade[];
};

/**
 * Splits the trade sequence into position lifecycles.
 *
 * A lifecycle runs from the trade that opens a position to the trade that takes its shares to zero.
 * The BUY-level and SELL-level "at most once" rules are per lifecycle, so they cannot be checked
 * against the whole trade log — a strategy that legitimately re-enters a symbol five times would
 * look like five duplicate firings.
 */
function buildLifecycles(
  trades: readonly EvidenceTrade[],
): readonly Lifecycle[] {
  const open = new Map<string, Lifecycle>();
  const all: Lifecycle[] = [];
  for (const trade of trades) {
    let lifecycle = open.get(trade.securityId);
    if (!lifecycle) {
      lifecycle = {
        securityId: trade.securityId,
        symbol: trade.symbol,
        trades: [],
      };
      open.set(trade.securityId, lifecycle);
      all.push(lifecycle);
    }
    lifecycle.trades.push(trade);
    if (n(trade.sharesAfter) <= 1e-12) {
      open.delete(trade.securityId);
    }
  }
  return all;
}

/**
 * BUY sizing — the one invariant that cannot be an equality, and exactly why.
 *
 * `target = portfolioValue x (1 / maximumPositions) x levelPercentage`, `shortfall = max(target -
 * currentPositionValue, 0)`, `spend = min(shortfall, cash)`. The engine computes that in **float**
 * on purpose: it chooses a target, it is not a ledger value, and nothing is ever reconciled against
 * it. Everything below the mutation boundary is exact, which is why every other check here is.
 *
 * `portfolioValue` is the value the whole date was sized against, and it is recoverable: trading at
 * the same close the holdings are marked at is value-neutral, so the portfolio value fixed before
 * the day's entries equals the day's recorded `totalValue`. "Value-neutral" is exact in decimal but
 * not in storage — `positionsValue` re-quantizes each *whole* position while a trade quantizes only
 * its own leg — so each trade on the date can move the recorded total by up to one and a half money
 * units away from the value that was actually sized against.
 *
 * That is the entire budget, and every term is derived rather than chosen:
 *
 *     1.5 money-ulp x trades on the date   the proxy for the pre-entry portfolio value
 *     2^-53 x magnitude x 8                the float64 path: two conversions, the sum, x fraction,
 *                                          x percentage, / 100, and the held-value product
 *     0.5 money-ulp                        quantizing the shortfall to the money scale
 *     price x share-ulp + 0.5 money-ulp    truncating the shares down, and quantizing the product
 *
 * At the largest run in the matrix that comes to about five hundredths of a cent. The check it
 * replaces allowed `expected x 1e-7` — $3,343 on a $33bn target.
 */
function checkBuySizing(
  evidence: RunEvidence,
  lifecycles: readonly Lifecycle[],
): InvariantResult {
  const violations: string[] = [];
  const totalByDate = new Map(
    evidence.equity.map((point) => [point.date, d(point.totalValue)]),
  );
  const tradesByDate = new Map<string, number>();
  for (const trade of evidence.trades) {
    tradesByDate.set(trade.date, (tradesByDate.get(trade.date) ?? 0) + 1);
  }
  // The identical float the engine holds in `fullPositionFraction`, so its rounding cancels
  // instead of being budgeted for.
  const fraction = 1 / evidence.maximumPositions;
  void lifecycles;

  for (const trade of evidence.trades) {
    if (trade.action !== "BUY" || trade.levelPercentage === null) {
      continue;
    }
    const totalValue = totalByDate.get(trade.date);
    if (totalValue === undefined) {
      violations.push(`#${trade.sequence}: no equity row on ${trade.date}.`);
      continue;
    }
    // Reconstructed through the same float operations the engine used, from an exact input.
    const portfolioValue = Number(totalValue);
    const target = portfolioValue * fraction * (trade.levelPercentage / 100);
    const sharesBefore = d(trade.sharesAfter).minus(d(trade.shares));
    const heldValue = Number(sharesBefore) * Number(d(trade.price));
    const cashBefore = money(d(trade.cashAfter).plus(d(trade.amount)));
    const shortfall = Math.max(target - heldValue, 0);
    const expected = Decimal.min(
      money(new V(shortfall)),
      cashBefore.gt(0) ? cashBefore : new V(0),
    );

    const magnitude = Decimal.max(
      totalValue.abs(),
      new V(Math.abs(target)),
      new V(Math.abs(heldValue)),
      cashBefore.abs(),
    );
    const budget = float64Slack(magnitude, 8)
      .plus(MONEY_ULP.times(1.5).times(tradesByDate.get(trade.date) ?? 1))
      .plus(MONEY_ULP)
      .plus(d(trade.price).times(SHARES_ULP));

    if (!within(d(trade.amount), expected, budget)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date} level ${trade.levelPercentage}%: spent ` +
          `${trade.amount} but target ${target} - held ${heldValue} capped at cash ` +
          `${cashBefore.toFixed(MONEY_SCALE)} gives ${expected.toFixed(MONEY_SCALE)}, which is ` +
          `${d(trade.amount).minus(expected).abs().toFixed(MONEY_SCALE)} away against a budget of ` +
          `${budget.toFixed(MONEY_SCALE)}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  const buys = evidence.trades.filter((trade) => trade.action === "BUY").length;
  return report(
    18,
    "buy-sizing",
    "BUY sizing matches the target/shortfall formula",
    violations,
    `${buys} BUYs reconcile against portfolioValue x ${fraction.toFixed(6)} x level%`,
  );
}

/**
 * The strongest eligible BUY level, as far as persisted evidence can settle it.
 *
 * The engine selects one level per security per date — the highest-percentage one whose Signal is
 * TRUE — so two BUY trades for one symbol on one date would be a direct contradiction of the rule.
 * Which level *was* strongest depends on the gates, which live only in the archive; that half is
 * proven there for the golden combinations.
 */
function checkStrongestLevel(evidence: RunEvidence): InvariantResult {
  const violations: string[] = [];
  const seen = new Set<string>();
  const levelIds = new Set(
    evidence.snapshot.strategy.definition.buyLevels.map((level) => level.id),
  );
  for (const trade of evidence.trades) {
    if (trade.action !== "BUY") {
      continue;
    }
    const key = `${trade.date}|${trade.securityId}`;
    if (seen.has(key)) {
      violations.push(
        `${trade.symbol} has more than one BUY on ${trade.date}; exactly one level may be selected per security per date.`,
      );
    }
    seen.add(key);
    if (trade.levelId !== null && !levelIds.has(trade.levelId)) {
      violations.push(
        `#${trade.sequence} names BUY level \`${trade.levelId}\`, which the snapshot's definition does not contain.`,
      );
    }
    if (violations.length > 10) {
      break;
    }
  }
  return report(
    19,
    "strongest-level",
    "Strongest eligible BUY level",
    violations,
    "one BUY level selected per security per date, each naming a level of the snapshotted definition",
  );
}

/**
 * That a settled BUY level stays settled for the life of the position.
 *
 * A level may trade once per lifecycle, plus once more on a date that actually deposited a
 * contribution. Reaching a higher tier settles every lower one, so a lower level firing after a
 * higher one in the same lifecycle is a violation even on a contribution date.
 */
function checkSettledLevels(
  evidence: RunEvidence,
  lifecycles: readonly Lifecycle[],
  contributionDates: readonly string[],
): InvariantResult {
  const violations: string[] = [];
  const contributionSet = new Set(contributionDates);
  for (const lifecycle of lifecycles) {
    const fired = new Map<string, string>();
    let highest = 0;
    for (const trade of lifecycle.trades) {
      if (trade.action !== "BUY" || trade.levelId === null) {
        continue;
      }
      const previous = fired.get(trade.levelId);
      if (previous !== undefined && !contributionSet.has(trade.date)) {
        violations.push(
          `${lifecycle.symbol}: BUY level \`${trade.levelId}\` fired on ${previous} and again on ` +
            `${trade.date}, which deposited no contribution.`,
        );
      }
      const percentage = trade.levelPercentage ?? 0;
      if (percentage < highest && !contributionSet.has(trade.date)) {
        violations.push(
          `${lifecycle.symbol}: level ${percentage}% traded on ${trade.date} after ${highest}% had ` +
            "already been reached in the same lifecycle; reaching a tier settles every smaller one.",
        );
      }
      highest = Math.max(highest, percentage);
      fired.set(trade.levelId, trade.date);
      if (violations.length > 10) {
        break;
      }
    }
  }
  return report(
    20,
    "settled-levels",
    "Settled BUY levels follow lifecycle rules",
    violations,
    `${lifecycles.length} position lifecycles, no level re-fired outside a contribution date`,
  );
}

function checkContributionTopUps(
  evidence: RunEvidence,
  lifecycles: readonly Lifecycle[],
  contributionDates: readonly string[],
  bySecurity: ReadonlyMap<string, BacktestRunSnapshot["securities"][number]>,
): InvariantResult {
  const violations: string[] = [];
  const contributionSet = new Set(contributionDates);
  let topUps = 0;
  for (const lifecycle of lifecycles) {
    const fired = new Set<string>();
    for (const trade of lifecycle.trades) {
      if (trade.action !== "BUY" || trade.levelId === null) {
        continue;
      }
      if (fired.has(trade.levelId)) {
        topUps += 1;
        if (!contributionSet.has(trade.date)) {
          violations.push(
            `${lifecycle.symbol}: level \`${trade.levelId}\` topped up on ${trade.date}, which is not a contribution date.`,
          );
        }
        if (n(evidence.monthlyContribution) <= 0) {
          violations.push(
            `${lifecycle.symbol}: a top-up occurred although this configuration contributes nothing.`,
          );
        }
        const security = bySecurity.get(trade.securityId);
        if (security && !buyWindowAdmits(security, trade.date)) {
          violations.push(
            `${lifecycle.symbol}: top-up on ${trade.date} is outside the buy window.`,
          );
        }
        if (n(trade.sharesAfter) - n(trade.shares) <= 1e-12) {
          violations.push(
            `${lifecycle.symbol}: a top-up on ${trade.date} opened a position rather than adding to one.`,
          );
        }
      }
      fired.add(trade.levelId);
      if (violations.length > 10) {
        break;
      }
    }
  }
  return report(
    21,
    "contribution-top-up",
    "Contribution-day top-up only when eligible",
    violations,
    `${topUps} top-up(s), each on a deposit date, into an open position, inside its buy window`,
  );
}

function checkNoRebalance(
  evidence: RunEvidence,
  lifecycles: readonly Lifecycle[],
  contributionDates: readonly string[],
): InvariantResult {
  const contributionSet = new Set(contributionDates);
  const violations: string[] = [];
  for (const lifecycle of lifecycles) {
    const fired = new Set<string>();
    for (const trade of lifecycle.trades) {
      if (trade.action !== "BUY" || trade.levelId === null) {
        continue;
      }
      const repeat = fired.has(trade.levelId);
      fired.add(trade.levelId);
      if (repeat && !contributionSet.has(trade.date)) {
        violations.push(
          `${lifecycle.symbol}: ${trade.date} added to an already-filled level with no deposit — that is a rebalance.`,
        );
      }
    }
  }
  void evidence;
  return report(
    22,
    "no-rebalance",
    "No general rebalance",
    violations,
    "no position was topped up merely for drifting below target",
  );
}

function checkSellFraction(trades: readonly EvidenceTrade[]): InvariantResult {
  const violations: string[] = [];
  for (const trade of trades) {
    if (trade.action !== "SELL" || trade.levelPercentage === null) {
      continue;
    }
    // `quantizeSharesDown(sharesHeld x percentage / 100)`, and every operand is persisted: the
    // shares before are the shares after plus the shares sold, exactly, at scale ten.
    const sharesBefore = d(trade.sharesAfter).plus(d(trade.shares));
    const expected = sharesDown(
      sharesBefore.times(trade.levelPercentage).div(100),
    );
    if (!d(trade.shares).eq(expected)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date}: sold ${trade.shares} of ` +
          `${sharesBefore.toFixed(SHARES_SCALE)} shares at ${trade.levelPercentage}%, expected ` +
          `${expected.toFixed(SHARES_SCALE)}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  const sells = trades.filter((trade) => trade.action === "SELL").length;
  return report(
    23,
    "sell-fraction",
    "SELL percentage applied to remaining shares",
    violations,
    `${sells} partial SELLs each took their percentage of the shares remaining at execution`,
  );
}

function checkSellLevelOnce(lifecycles: readonly Lifecycle[]): InvariantResult {
  const violations: string[] = [];
  for (const lifecycle of lifecycles) {
    const fired = new Map<string, string>();
    for (const trade of lifecycle.trades) {
      if (trade.action !== "SELL" || trade.levelId === null) {
        continue;
      }
      const previous = fired.get(trade.levelId);
      if (previous !== undefined) {
        violations.push(
          `${lifecycle.symbol}: SELL level \`${trade.levelId}\` fired on ${previous} and again on ${trade.date} in one lifecycle.`,
        );
      }
      fired.set(trade.levelId, trade.date);
    }
  }
  return report(
    24,
    "sell-once",
    "SELL level fires at most once per lifecycle",
    violations,
    "no SELL level fired twice within one position lifecycle",
  );
}

function checkFinalExitCloses(
  trades: readonly EvidenceTrade[],
): InvariantResult {
  const violations: string[] = [];
  for (const trade of trades) {
    if (trade.action !== "FINAL_EXIT") {
      continue;
    }
    if (n(trade.sharesAfter) > 1e-12) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date}: FINAL EXIT left ${n(trade.sharesAfter)} shares open.`,
      );
    }
    if (trade.averageCostAfter !== null) {
      violations.push(
        `#${trade.sequence} ${trade.symbol}: FINAL EXIT recorded an average cost for a closed position.`,
      );
    }
    if (trade.levelPercentage !== null) {
      violations.push(
        `#${trade.sequence} ${trade.symbol}: FINAL EXIT carries a level percentage; it has none.`,
      );
    }
  }
  const exits = trades.filter((trade) => trade.action === "FINAL_EXIT").length;
  return report(
    25,
    "final-exit-closes",
    "FINAL EXIT closes the remaining position",
    violations,
    `${exits} FINAL EXITs each closed the whole remaining position`,
  );
}

function checkNoSameDateReentry(
  trades: readonly EvidenceTrade[],
): InvariantResult {
  const violations: string[] = [];
  const closedToday = new Set<string>();
  let currentDate: string | null = null;
  for (const trade of trades) {
    if (trade.date !== currentDate) {
      closedToday.clear();
      currentDate = trade.date;
    }
    if (trade.action === "BUY" && closedToday.has(trade.securityId)) {
      violations.push(
        `${trade.symbol} closed and re-opened on ${trade.date}; same-date re-entry is forbidden.`,
      );
    }
    if (n(trade.sharesAfter) <= 1e-12) {
      closedToday.add(trade.securityId);
    }
  }
  return report(
    26,
    "no-same-date-reentry",
    "No same-date re-entry after FINAL EXIT",
    violations,
    "no security opened a new position on the date its previous one closed",
  );
}

/**
 * That a partial SELL does not block an eligible BUY later the same date.
 *
 * Permitted behaviour rather than a rule to enforce, so this reports how often it happened. A count
 * of zero across a whole matrix would mean the allowance is untested, which is worth seeing.
 */
function checkPartialSellThenBuy(
  trades: readonly EvidenceTrade[],
): InvariantResult {
  let observed = 0;
  const soldToday = new Map<string, number>();
  let currentDate: string | null = null;
  for (const trade of trades) {
    if (trade.date !== currentDate) {
      soldToday.clear();
      currentDate = trade.date;
    }
    if (
      trade.action === "BUY" &&
      (soldToday.get(trade.securityId) ?? 0) > 0 &&
      n(trade.sharesAfter) - n(trade.shares) > 1e-12
    ) {
      observed += 1;
    }
    if (trade.action === "SELL" && n(trade.sharesAfter) > 1e-12) {
      soldToday.set(
        trade.securityId,
        (soldToday.get(trade.securityId) ?? 0) + 1,
      );
    }
  }
  return {
    id: 27,
    key: "partial-sell-then-buy",
    title: "Partial SELL then eligible BUY on the same date",
    status: "PASS",
    detail: `${observed} same-date partial-sell-then-top-up sequence(s), which remain allowed`,
  };
}

/**
 * Average-cost basis, checked step by step rather than by replaying the whole run.
 *
 * A cumulative replay from rounded persisted values drifts against an engine that accumulated
 * unrounded ones, and the drift would eventually be reported as a defect. Each trade instead has to
 * satisfy a local identity: a BUY adds its amount to the basis, and a partial SELL removes shares
 * and cost *proportionally*, so the basis per share is unchanged — that second property is exact,
 * and it is the one that makes `Gain` keep describing the same position.
 */
/**
 * The engine's own cost state for one position, and how each trade moves it.
 *
 * `PositionState` carries **two** canonical values and both are needed, which is the whole reason
 * the ledger looks like this. Deriving the basis from an accumulated cost total drifts across
 * partial sells; deriving the cost total from an eight-decimal basis loses $10.44 on a
 * 2.4-billion-share position. So the basis is pinned — a partial sell never moves it — and the cost
 * total is reduced by the cost actually removed, each exact at its own declared scale.
 *
 * Rebuilding both here is what turns invariants 28, 29 and 30 into equalities. The old validator
 * re-derived the cost as `sharesBefore x averageCostBefore`, which is a different number from the
 * one the engine carries, and then bought a tolerance wide enough to hide the difference: at the
 * one-dollar configuration `0.005 / shares` came to **29.77**, wide enough to accept a basis of
 * $178 for a stock that closed at $148.84.
 */
type CostState = {
  readonly shares: Decimal;
  readonly averageCost: Decimal;
  readonly costTotal: Decimal;
};

type CostStep = {
  readonly before: CostState;
  readonly after: CostState;
  /** The cost the exit removed — the whole basis when it closed the position. */
  readonly costRemoved: Decimal;
};

function emptyCost(): CostState {
  return { shares: new V(0), averageCost: new V(0), costTotal: new V(0) };
}

/**
 * Walks the trade log and reproduces the cost state on each side of every trade.
 *
 * Deliberately driven by what was persisted rather than by what the state implies: `applyBuy` and
 * `applySell` are re-executed on the persisted `amount`, `shares`, `price` and `fees`, so a
 * disagreement is attributed to the trade that caused it instead of to every trade after it.
 */
function walkCostLedger(trades: readonly EvidenceTrade[]): readonly CostStep[] {
  const steps: CostStep[] = [];
  const open = new Map<string, CostState>();
  for (const trade of trades) {
    const before = open.get(trade.securityId) ?? emptyCost();
    if (trade.action === "BUY") {
      const costTotal = money(
        before.costTotal.plus(d(trade.amount)).plus(d(trade.fees)),
      );
      const shares = before.shares.plus(d(trade.shares));
      const after: CostState = {
        shares,
        averageCost: shares.gt(0) ? price(costTotal.div(shares)) : new V(0),
        costTotal,
      };
      steps.push({ before, after, costRemoved: new V(0) });
      open.set(trade.securityId, after);
      continue;
    }
    // A full exit removes exactly the whole basis, so the position closes at precisely zero rather
    // than at whatever a proportional calculation happened to leave behind.
    const closes = d(trade.shares).gte(before.shares);
    const costRemoved = closes
      ? before.costTotal
      : money(before.averageCost.times(d(trade.shares)));
    const after: CostState = closes
      ? emptyCost()
      : {
          shares: before.shares.minus(d(trade.shares)),
          // Untouched by a partial sell: that is the AVERAGE_COST policy.
          averageCost: before.averageCost,
          costTotal: money(before.costTotal.minus(costRemoved)),
        };
    steps.push({ before, after, costRemoved });
    open.set(trade.securityId, after);
  }
  return steps;
}

/** The cost state each security ended the run in, for the final open positions. */
function finalCostStates(
  steps: readonly CostStep[],
  trades: readonly EvidenceTrade[],
): ReadonlyMap<string, CostState> {
  const final = new Map<string, CostState>();
  steps.forEach((step, index) => {
    final.set((trades[index] as EvidenceTrade).securityId, step.after);
  });
  return final;
}

function checkAverageCost(
  trades: readonly EvidenceTrade[],
  steps: readonly CostStep[],
): InvariantResult {
  const violations: string[] = [];
  trades.forEach((trade, index) => {
    if (violations.length > 10) {
      return;
    }
    const { before, after } = steps[index] as CostStep;
    if (!d(trade.sharesAfter).eq(after.shares)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date}: sharesAfter ${trade.sharesAfter} but ` +
          `${before.shares.toFixed(SHARES_SCALE)} ${trade.action === "BUY" ? "+" : "-"} ` +
          `${trade.shares} = ${after.shares.toFixed(SHARES_SCALE)}.`,
      );
    }
    if (after.shares.isZero()) {
      // A closed position has no basis to report, and reporting one would imply shares.
      if (trade.averageCostAfter !== null) {
        violations.push(
          `#${trade.sequence} ${trade.symbol} ${trade.date}: the position closed but ` +
            `averageCostAfter is ${trade.averageCostAfter}.`,
        );
      }
      return;
    }
    if (
      trade.averageCostAfter === null ||
      !d(trade.averageCostAfter).eq(after.averageCost)
    ) {
      violations.push(
        trade.action === "BUY"
          ? `#${trade.sequence} ${trade.symbol} ${trade.date}: averageCostAfter ` +
              `${trade.averageCostAfter ?? "null"} but a cost total of ` +
              `${after.costTotal.toFixed(MONEY_SCALE)} over ${after.shares.toFixed(SHARES_SCALE)} ` +
              `shares is ${after.averageCost.toFixed(PRICE_SCALE)}.`
          : `#${trade.sequence} ${trade.symbol} ${trade.date}: a partial SELL moved the basis per ` +
              `share from ${before.averageCost.toFixed(PRICE_SCALE)} to ` +
              `${trade.averageCostAfter ?? "null"}; AVERAGE_COST reduces shares and cost ` +
              "proportionally, leaving the basis where it was.",
      );
    }
  });
  return report(
    28,
    "average-cost",
    "Average-cost basis reconciles",
    violations,
    "every BUY re-averages the basis from the cost total and every partial SELL leaves it unchanged",
  );
}

/**
 * Realized profit and loss, re-derived from the cost the exit actually removed.
 *
 * `proceeds - costRemoved - fees`, quantized once — not `shares x (price - basis)`, which is a
 * different number whenever the basis carries more precision than eight decimals can hold, and
 * which is what the old validator compared against under a budget of `shares x 1e-8` (a dollar of
 * slack on a 273-million-share position, and $909 on the matrix's whole trade log).
 *
 * The summed check is exact for the same reason: the engine accumulates the very values it
 * persisted, each already at money scale, so the total is a sum of scale-six numbers.
 */
function checkRealizedPnl(
  evidence: RunEvidence,
  steps: readonly CostStep[],
): InvariantResult {
  const violations: string[] = [];
  let total = new V(0);
  evidence.trades.forEach((trade, index) => {
    if (violations.length > 10) {
      return;
    }
    if (trade.action === "BUY") {
      if (trade.realizedPnl !== null) {
        violations.push(
          `#${trade.sequence} ${trade.symbol}: a BUY carries realized P&L.`,
        );
      }
      return;
    }
    const { costRemoved } = steps[index] as CostStep;
    const expected = money(
      d(trade.amount).minus(costRemoved).minus(d(trade.fees)),
    );
    if (trade.realizedPnl === null || !d(trade.realizedPnl).eq(expected)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} ${trade.date}: realizedPnl ` +
          `${trade.realizedPnl ?? "null"} but proceeds ${trade.amount} - cost removed ` +
          `${costRemoved.toFixed(MONEY_SCALE)} - fees ${trade.fees} = ${expected.toFixed(MONEY_SCALE)}.`,
      );
    }
    total = money(total.plus(d(trade.realizedPnl)));
  });
  const summary = evidence.summary;
  if (summary && !d(summary.realizedPnl).eq(total)) {
    violations.push(
      `Summary realizedPnl ${summary.realizedPnl} but the persisted trades sum to ${total.toFixed(
        MONEY_SCALE,
      )}.`,
    );
  }
  return report(
    29,
    "realized-pnl",
    "Realized P&L reconciles",
    violations,
    `every exit's realized P&L equals proceeds - cost removed, summing to ${total.toFixed(MONEY_SCALE)}`,
  );
}

/**
 * Unrealized profit and loss on the positions still open at the end.
 *
 * `marketValue - costTotal`, against the cost total the ledger reached — again not
 * `shares x (price - basis)`. On a 2.4-billion-share position those two differ by $10.44, which is
 * precisely the measurement that made the position carry both values in the first place.
 */
function checkUnrealizedPnl(
  evidence: RunEvidence,
  costs: ReadonlyMap<string, CostState>,
): InvariantResult {
  const violations: string[] = [];
  let total = new V(0);
  for (const position of evidence.positions) {
    const mark = price(d(position.lastPrice));
    const expectedValue = money(d(position.shares).times(mark));
    if (!d(position.marketValue).eq(expectedValue)) {
      violations.push(
        `${position.symbol}: marketValue ${position.marketValue} but ${position.shares} x ` +
          `${position.lastPrice} = ${expectedValue.toFixed(MONEY_SCALE)}.`,
      );
    }
    const cost = costs.get(position.securityId);
    if (!cost) {
      violations.push(
        `${position.symbol}: a position is open at the end but the trade log never opened one.`,
      );
    } else {
      if (!d(position.shares).eq(cost.shares)) {
        violations.push(
          `${position.symbol}: holds ${position.shares} shares but the trade log leaves ` +
            `${cost.shares.toFixed(SHARES_SCALE)}.`,
        );
      }
      if (!d(position.averageCost).eq(cost.averageCost)) {
        violations.push(
          `${position.symbol}: averageCost ${position.averageCost} but the trade log leaves ` +
            `${cost.averageCost.toFixed(PRICE_SCALE)}.`,
        );
      }
      const expectedPnl = money(expectedValue.minus(cost.costTotal));
      if (!d(position.unrealizedPnl).eq(expectedPnl)) {
        violations.push(
          `${position.symbol}: unrealizedPnl ${position.unrealizedPnl} but market value ` +
            `${expectedValue.toFixed(MONEY_SCALE)} - cost ${cost.costTotal.toFixed(MONEY_SCALE)} = ` +
            `${expectedPnl.toFixed(MONEY_SCALE)}.`,
        );
      }
    }
    total = money(total.plus(d(position.unrealizedPnl)));
  }
  const summary = evidence.summary;
  if (summary && !d(summary.unrealizedPnl).eq(total)) {
    violations.push(
      `Summary unrealizedPnl ${summary.unrealizedPnl} but the positions sum to ${total.toFixed(
        MONEY_SCALE,
      )}.`,
    );
  }
  return report(
    30,
    "unrealized-pnl",
    "Unrealized P&L reconciles",
    violations,
    `${evidence.positions.length} open positions reconcile to ${total.toFixed(MONEY_SCALE)}`,
  );
}

function checkFinalPositions(evidence: RunEvidence): InvariantResult {
  const violations: string[] = [];
  const last = evidence.equity[evidence.equity.length - 1];
  if (!last) {
    return report(
      31,
      "final-positions",
      "Final positions reconcile with the last equity state",
      ["The run has no equity rows."],
      "",
    );
  }
  // The engine's `positionsValue` is a decimal sum of exactly these quantized products, so the
  // last equity row and the position rows are two spellings of one number.
  const marketValue = evidence.positions.reduce(
    (sum, position) => money(sum.plus(d(position.marketValue))),
    new V(0),
  );
  if (!d(last.positionsValue).eq(marketValue)) {
    violations.push(
      `Final equity positionsValue ${last.positionsValue} but the persisted positions sum to ` +
        `${marketValue.toFixed(MONEY_SCALE)}.`,
    );
  }
  if (last.openPositions !== evidence.positions.length) {
    violations.push(
      `Final equity records ${last.openPositions} open positions but ${evidence.positions.length} rows were persisted.`,
    );
  }
  return report(
    31,
    "final-positions",
    "Final positions reconcile with the last equity state",
    violations,
    `${evidence.positions.length} positions worth ${marketValue.toFixed(MONEY_SCALE)} on ${last.date}`,
  );
}

function checkSummaryFinalValue(evidence: RunEvidence): InvariantResult {
  const violations: string[] = [];
  const last = evidence.equity[evidence.equity.length - 1];
  const summary = evidence.summary;
  if (!summary || !last) {
    return report(
      32,
      "summary-final-value",
      "Summary final value reconciles",
      ["The run has no summary or no equity rows."],
      "",
    );
  }
  // The summary's three closing figures are the last equity row, copied. Not "close to it": the
  // engine writes `lastEquity.cash`, `lastEquity.positionsValue` and `lastEquity.totalValue`
  // through, so anything but equality means one of the two was written from something else.
  if (!d(summary.finalValue).eq(d(last.totalValue))) {
    violations.push(
      `Summary finalValue ${summary.finalValue} but the last equity row is ${last.totalValue}.`,
    );
  }
  if (!d(summary.finalCash).eq(d(last.cash))) {
    violations.push(
      `Summary finalCash ${summary.finalCash} but the last equity row is ${last.cash}.`,
    );
  }
  if (!d(summary.finalPositionsValue).eq(d(last.positionsValue))) {
    violations.push(
      `Summary finalPositionsValue ${summary.finalPositionsValue} but the last equity row is ${last.positionsValue}.`,
    );
  }
  if (summary.lastSimulatedDate !== last.date) {
    violations.push(
      `Summary lastSimulatedDate ${summary.lastSimulatedDate} but the last equity row is ${last.date}.`,
    );
  }
  const first = evidence.equity[0] as EvidenceEquity;
  if (summary.firstSimulatedDate !== first.date) {
    violations.push(
      `Summary firstSimulatedDate ${summary.firstSimulatedDate} but the first equity row is ${first.date}.`,
    );
  }
  if (summary.tradingDays !== evidence.equity.length) {
    violations.push(
      `Summary tradingDays ${summary.tradingDays} but ${evidence.equity.length} equity rows exist.`,
    );
  }
  const netProfit = money(
    d(summary.finalValue).minus(d(summary.investedCapital)),
  );
  if (!d(summary.netProfit).eq(netProfit)) {
    violations.push(
      `Summary netProfit ${summary.netProfit} but finalValue - investedCapital = ${netProfit.toFixed(
        MONEY_SCALE,
      )}.`,
    );
  }
  return report(
    32,
    "summary-final-value",
    "Summary final value reconciles",
    violations,
    `final value ${summary.finalValue} on ${summary.lastSimulatedDate}`,
  );
}

function checkInvestedCapital(
  evidence: RunEvidence,
  contributionDates: readonly string[],
): InvariantResult {
  const violations: string[] = [];
  // The funding schedule is arithmetic on two persisted scale-six amounts and a count of dates.
  // The old check allowed `expected x 1e-7`, which at the largest run in the matrix is $33,431.07
  // of capital that could appear from nowhere.
  const expected = money(
    d(evidence.initialCapital).plus(
      d(evidence.monthlyContribution).times(contributionDates.length),
    ),
  );
  const summary = evidence.summary;
  if (summary && !d(summary.investedCapital).eq(expected)) {
    violations.push(
      `Summary investedCapital ${summary.investedCapital} but ${evidence.initialCapital} + ` +
        `${contributionDates.length} x ${evidence.monthlyContribution} = ${expected.toFixed(MONEY_SCALE)}.`,
    );
  }
  const last = evidence.equity[evidence.equity.length - 1];
  if (last && !d(last.investedCapital).eq(expected)) {
    violations.push(
      `Final equity investedCapital ${last.investedCapital} but the schedule gives ${expected.toFixed(
        MONEY_SCALE,
      )}.`,
    );
  }
  if (last && !d(last.cashBaselineValue).eq(expected)) {
    violations.push(
      `Final cashBaselineValue ${last.cashBaselineValue} but the schedule gives ${expected.toFixed(
        MONEY_SCALE,
      )}.`,
    );
  }
  return report(
    33,
    "invested-capital",
    "Invested capital reconciles",
    violations,
    `${expected.toFixed(MONEY_SCALE)} of external capital across ${contributionDates.length + 1} funding events`,
  );
}

function checkTradeCounts(evidence: RunEvidence): InvariantResult {
  const summary = evidence.summary;
  if (!summary) {
    return report(
      34,
      "trade-counts",
      "Trade counts reconcile",
      ["No summary."],
      "",
    );
  }
  const violations: string[] = [];
  const buys = evidence.trades.filter((t) => t.action === "BUY").length;
  const sells = evidence.trades.filter((t) => t.action === "SELL").length;
  const exits = evidence.trades.filter((t) => t.action === "FINAL_EXIT").length;
  // Classified from the canonical value, not a float projection of it: at money scale six the
  // smallest win is 0.000001 and it is a win.
  const winning = evidence.trades.filter(
    (t) => t.realizedPnl !== null && d(t.realizedPnl).gt(0),
  ).length;
  const losing = evidence.trades.filter(
    (t) => t.realizedPnl !== null && d(t.realizedPnl).lt(0),
  ).length;

  const compare = (label: string, actual: number, expected: number): void => {
    if (actual !== expected) {
      violations.push(
        `Summary ${label} ${actual} but the trades give ${expected}.`,
      );
    }
  };
  compare("totalTrades", summary.totalTrades, evidence.trades.length);
  compare("buyTrades", summary.buyTrades, buys);
  compare("sellTrades", summary.sellTrades, sells);
  compare("finalExitTrades", summary.finalExitTrades, exits);
  compare("winningTrades", summary.winningTrades, winning);
  compare("losingTrades", summary.losingTrades, losing);

  // `BacktestSimulation` numbers trades from one, densely, in execution order, and `(runId,
  // sequence)` is unique — so a gap or a repeat means a trade was lost or written twice.
  const sequences = evidence.trades.map((t) => t.sequence);
  for (let index = 0; index < sequences.length; index += 1) {
    if (sequences[index] !== index + 1) {
      violations.push(
        `Trade sequence is not dense and ascending from one at position ${index} (found ${sequences[index]}).`,
      );
      break;
    }
  }
  return report(
    34,
    "trade-counts",
    "Trade counts reconcile",
    violations,
    `${evidence.trades.length} trades: ${buys} BUY, ${sells} SELL, ${exits} FINAL EXIT`,
  );
}

function checkPositionCount(evidence: RunEvidence): InvariantResult {
  const summary = evidence.summary;
  const violations: string[] = [];
  if (summary && summary.openPositions !== evidence.positions.length) {
    violations.push(
      `Summary openPositions ${summary.openPositions} but ${evidence.positions.length} position rows exist.`,
    );
  }
  const symbols = new Set(evidence.positions.map((p) => p.securityId));
  if (symbols.size !== evidence.positions.length) {
    violations.push("A security has more than one final position row.");
  }
  for (const position of evidence.positions) {
    if (n(position.shares) <= 0) {
      violations.push(
        `${position.symbol} was persisted with ${n(position.shares)} shares.`,
      );
    }
  }
  return report(
    35,
    "position-count",
    "Position count reconciles",
    violations,
    `${evidence.positions.length} open positions, one row per security`,
  );
}

/**
 * Buy-window boundary behaviour, as far as the trade log can settle it.
 *
 * Inclusion is directly checkable: a BUY on the exact first or last date of a window must be
 * permitted, and one outside must not exist (invariant 11 covers the second half). What the log
 * cannot show is a BUY that *should* have happened on a boundary and did not, because the Signal
 * may simply have been FALSE — that half needs the frames, and is proven from the archive.
 */
function checkBuyWindowBoundaries(
  evidence: RunEvidence,
  bySecurity: ReadonlyMap<string, BacktestRunSnapshot["securities"][number]>,
  calendar: ExecutionCalendar,
): InvariantResult {
  const violations: string[] = [];
  let boundaryBuys = 0;
  for (const trade of evidence.trades) {
    if (trade.action !== "BUY") {
      continue;
    }
    const security = bySecurity.get(trade.securityId);
    if (!security || security.buyWindowMode !== "CUSTOM") {
      continue;
    }
    for (const range of security.buyWindows) {
      if (trade.date === range.startDate || trade.date === range.endDate) {
        boundaryBuys += 1;
      }
    }
    // A window endpoint that is not an execution date can never be traded on, which makes the
    // boundary untestable rather than wrong — worth reporting, not failing.
    if (!calendar.has(trade.date)) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} traded on ${trade.date}, which is not an execution date.`,
      );
    }
  }
  return report(
    38,
    "buy-window-boundaries",
    "Buy-window boundary inclusion",
    violations,
    `${boundaryBuys} BUY(s) executed exactly on a window endpoint; every BUY fell on an execution date`,
  );
}

function checkNoPreListingTrades(evidence: RunEvidence): InvariantResult {
  const violations: string[] = [];
  for (const trade of evidence.trades) {
    const firstPrice = evidence.firstPriceDateBySecurityId.get(
      trade.securityId,
    );
    if (firstPrice && trade.date < firstPrice) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} traded on ${trade.date}, before its first canonical price ${firstPrice}.`,
      );
    }
  }
  for (const position of evidence.positions) {
    const firstPrice = evidence.firstPriceDateBySecurityId.get(
      position.securityId,
    );
    if (firstPrice && position.openedDate < firstPrice) {
      violations.push(
        `${position.symbol} was opened on ${position.openedDate}, before its first canonical price ${firstPrice}.`,
      );
    }
  }
  return report(
    39,
    "no-pre-listing-trades",
    "No trading before listing or data availability",
    violations,
    "no trade or position predates its security's first canonical price",
  );
}

/**
 * That no warm-up date became a simulated date.
 *
 * Raw prices are retained four years beyond the thirty-year product horizon so a 200-week average
 * is already valid on the first visible day. That extra history is internal: it must feed the
 * derived series and must never be a date the portfolio trades on, holds an equity point for, or
 * bases its return index at.
 */
function checkNoWarmupDates(
  evidence: RunEvidence,
  calendar: ExecutionCalendar,
): InvariantResult {
  const violations: string[] = [];
  const first = calendar.first;
  for (const point of evidence.equity) {
    if (point.date < evidence.startDate || point.date > evidence.endDate) {
      violations.push(
        `${point.date} is an equity date outside the requested period ${evidence.startDate}..${evidence.endDate}.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  for (const trade of evidence.trades) {
    if (trade.date < evidence.startDate || trade.date > evidence.endDate) {
      violations.push(
        `#${trade.sequence} ${trade.symbol} traded on ${trade.date}, outside the requested period.`,
      );
      if (violations.length > 10) {
        break;
      }
    }
  }
  const firstEquity = evidence.equity[0];
  if (firstEquity && first && firstEquity.date !== first) {
    violations.push(
      `The run's first simulated date is ${firstEquity.date} but the first execution date in the period is ${first}.`,
    );
  }
  return report(
    40,
    "no-warmup-dates",
    "No warm-up date is simulated",
    violations,
    `every simulated date lies inside ${evidence.startDate}..${evidence.endDate}, starting at ${first ?? "—"}`,
  );
}

/** Summarizes a run's invariant results for the report. */
export function summarizeInvariants(results: readonly InvariantResult[]): {
  readonly passed: number;
  readonly failed: number;
  readonly needsArchive: number;
  readonly notApplicable: number;
} {
  return {
    passed: results.filter((r) => r.status === "PASS").length,
    failed: results.filter((r) => r.status === "FAIL").length,
    needsArchive: results.filter((r) => r.status === "NEEDS_ARCHIVE").length,
    notApplicable: results.filter((r) => r.status === "NOT_APPLICABLE").length,
  };
}
