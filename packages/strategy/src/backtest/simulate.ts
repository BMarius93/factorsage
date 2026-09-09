import type { StrategyDefinition } from "@intrinsic/contracts";
import { isBuyWindowEligible, type LocalDate } from "@intrinsic/domain";
import { Evaluability, evaluabilityAnd } from "../evaluability.js";
import type { EvaluationFrame } from "../frame.js";
import { buildStrategyGates, readGate, type StrategyGates } from "../gates.js";
import {
  applyBuy,
  applySell,
  averageCost,
  evaluatePositionSignal,
  gainPercent,
  type PositionState,
} from "../position.js";
import { BenchmarkCursor } from "./benchmark.js";
import { buildContributionDates, buildExecutionCalendar } from "./calendar.js";
import {
  DrawdownTracker,
  alphaPercent,
  cagrPercent,
  chainReturnIndex,
  downsample,
  indexToPercent,
} from "./metrics.js";
import { V1_FEE_PER_TRADE } from "./methodology.js";
import type {
  BacktestCheckpoint,
  BacktestCheckpointHolding,
  BacktestCurvePoint,
  BacktestEquityPoint,
  BacktestExecutionInput,
  BacktestOpenPosition,
  BacktestResult,
  BacktestSecurityInput,
  BacktestSimulationOptions,
  BacktestSummary,
  BacktestTradeRecord,
} from "./types.js";

const DEFAULT_CHECKPOINT_EVERY_DAYS = 5;
const DEFAULT_MAX_CURVE_POINTS = 360;
const DEFAULT_RECENT_TRADE_COUNT = 10;

/** Everything the loop needs about one list member, resolved once. */
type SecurityRuntime = {
  input: BacktestSecurityInput;
  frame: EvaluationFrame;
  gates: StrategyGates;
  /** Cursor into the security's own frame; the union calendar advances it forward only. */
  cursor: number;
};

type BuyCandidate = {
  runtime: SecurityRuntime;
  frameIndex: number;
  levelId: string;
  percentage: number;
  isTopUp: boolean;
  /**
   * True when this candidate exists only because new capital was deposited today: the level had
   * already fired for this position and is being reconsidered against the larger portfolio.
   */
  isContributionTopUp: boolean;
};

export class BacktestExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestExecutionError";
  }
}

/**
 * Runs one deterministic portfolio simulation.
 *
 * Ordering inside a date is fixed and is engine methodology, versioned in the run snapshot
 * (`EXECUTION_METHODOLOGY_VERSION`):
 *
 * 1. apply the monthly contribution when this is the first simulated trading day of a month;
 * 2. value the portfolio, carrying each holding forward at its most recent close;
 * 3. exits — FINAL EXIT first, then SELL levels in definition order;
 * 4. entries — read the precomputed BUY gate for every security whose buy window admits the date;
 * 5. order the candidates and size them under `fullPositionFraction = 1 / maximumPositions`,
 *    enforcing available cash and the position-slot cap;
 * 6. record the day's equity point.
 *
 * Nothing reads a clock, no iteration depends on hash order, and checkpoints are pure observation,
 * so the same input always produces the same output.
 */
export async function simulateBacktest(
  input: BacktestExecutionInput,
  options: BacktestSimulationOptions = {},
): Promise<BacktestResult> {
  assertInput(input);

  const runtimes: SecurityRuntime[] = input.securities.map((security) => ({
    input: security,
    frame: security.frame,
    gates: buildStrategyGates(input.definition, security.frame),
    cursor: 0,
  }));
  const runtimesById = new Map<string, SecurityRuntime>(
    runtimes.map((runtime) => [runtime.frame.securityId, runtime]),
  );

  if (input.executionCalendar.length === 0) {
    throw new BacktestExecutionError(
      "A backtest needs its execution calendar: the dates it simulates are methodology, not a " +
        "consequence of which securities happened to load",
    );
  }
  const calendar = buildExecutionCalendar(
    input.startDate,
    input.endDate,
    input.executionCalendar,
  );
  if (calendar.length === 0) {
    throw new BacktestExecutionError(
      "The requested period contains no eligible trading day for any security in the list",
    );
  }

  const contributionDates = buildContributionDates(calendar);
  const benchmark = new BenchmarkCursor(input.benchmark);
  const definition = input.definition;
  const fullPositionFraction = 1 / input.maximumPositions;

  const positions = new Map<string, PositionState>();
  const epochs = new Map<string, number>();
  const trades: BacktestTradeRecord[] = [];
  const equity: BacktestEquityPoint[] = [];
  const curve: BacktestCurvePoint[] = [];
  const drawdown = new DrawdownTracker();
  const benchmarkDrawdown = new DrawdownTracker();

  let cash = input.initialCapital;
  let investedCapital = input.initialCapital;
  let returnIndex = 1;
  let previousTotalValue = input.initialCapital;
  let realizedPnl = 0;
  let sequence = 0;

  const checkpointEveryDays =
    options.checkpointEveryDays ?? DEFAULT_CHECKPOINT_EVERY_DAYS;
  const maxCurvePoints = options.maxCurvePoints ?? DEFAULT_MAX_CURVE_POINTS;
  const recentTradeCount =
    options.recentTradeCount ?? DEFAULT_RECENT_TRADE_COUNT;

  const recordTrade = (trade: Omit<BacktestTradeRecord, "sequence">): void => {
    sequence += 1;
    trades.push({ sequence, ...trade });
  };

  for (let day = 0; day < calendar.length; day += 1) {
    const date = calendar[day] as LocalDate;
    const year = date.slice(0, 4);

    // 1. Cash in.
    const contribution =
      input.monthlyContribution > 0 && contributionDates.has(date)
        ? input.monthlyContribution
        : 0;
    const depositedToday = contribution > 0;
    if (depositedToday) {
      cash += contribution;
      investedCapital += contribution;
    }

    // 2. Advance every frame cursor to this date and mark holdings.
    for (const runtime of runtimes) {
      runtime.cursor = advanceCursor(runtime, date);
    }
    for (const position of positions.values()) {
      const runtime = runtimeFor(runtimesById, position.securityId);
      const close = closeAt(runtime, date);
      if (close !== null) {
        position.lastPrice = close;
        position.lastPriceDate = date;
      }
    }

    // Snapshotted before exits: a security whose position closes today cannot be re-entered today.
    // Selling and rebuying at the same close is an economic no-op that would fabricate two trades
    // and silently reset the position's level state.
    const openAtDayStart = new Set(positions.keys());

    // 3. Exits, in a deterministic order independent of insertion order.
    for (const position of sortedPositions(positions)) {
      const runtime = runtimeFor(runtimesById, position.securityId);
      const index = frameIndexAt(runtime, date);
      if (index < 0) {
        continue;
      }
      const close = runtime.frame.closes[index];
      if (close === undefined || !Number.isFinite(close) || close <= 0) {
        continue;
      }
      const previousDate =
        index > 0 ? (runtime.frame.dates[index - 1] as LocalDate) : undefined;
      const context = { close, position, previousDate };

      // FINAL EXIT outranks a matching partial SELL on the same date.
      if (definition.finalExit) {
        const result = evaluabilityAnd(
          readGate(runtime.gates.finalExit ?? undefined, index),
          evaluatePositionSignal(definition.finalExit.signal, context),
        );
        if (result === Evaluability.TRUE) {
          const shares = position.shares;
          const { realizedPnl: pnl, costRemoved } = applySell(
            position,
            shares,
            close,
            V1_FEE_PER_TRADE,
          );
          cash += shares * close - V1_FEE_PER_TRADE;
          realizedPnl += pnl;
          recordTrade({
            date,
            securityId: position.securityId,
            symbol: position.symbol,
            name: position.name,
            action: "FINAL_EXIT",
            levelId: definition.finalExit.id,
            levelPercentage: null,
            shares,
            price: close,
            amount: shares * close,
            fees: V1_FEE_PER_TRADE,
            realizedPnl: pnl,
            realizedPnlPercent:
              costRemoved > 0 ? (pnl / costRemoved) * 100 : null,
            cashAfter: cash,
            sharesAfter: 0,
            averageCostAfter: null,
          });
          positions.delete(position.securityId);
          continue;
        }
      }

      for (const level of definition.sellLevels) {
        if (position.shares <= 0 || position.sellLevelsFired.has(level.id)) {
          continue;
        }
        const result = evaluabilityAnd(
          readGate(runtime.gates.sell.get(level.id), index),
          evaluatePositionSignal(level.signal, context),
        );
        if (result !== Evaluability.TRUE) {
          continue;
        }
        // The percentage is a fraction of the position remaining at execution time.
        const shares = (position.shares * level.percentage) / 100;
        if (!(shares > 0)) {
          continue;
        }
        const { realizedPnl: pnl, costRemoved } = applySell(
          position,
          shares,
          close,
          V1_FEE_PER_TRADE,
        );
        cash += shares * close - V1_FEE_PER_TRADE;
        realizedPnl += pnl;
        position.sellLevelsFired.add(level.id);
        recordTrade({
          date,
          securityId: position.securityId,
          symbol: position.symbol,
          name: position.name,
          action: "SELL",
          levelId: level.id,
          levelPercentage: level.percentage,
          shares,
          price: close,
          amount: shares * close,
          fees: V1_FEE_PER_TRADE,
          realizedPnl: pnl,
          realizedPnlPercent:
            costRemoved > 0 ? (pnl / costRemoved) * 100 : null,
          cashAfter: cash,
          sharesAfter: position.shares,
          averageCostAfter: position.shares > 0 ? averageCost(position) : null,
        });
        if (position.shares <= 0) {
          positions.delete(position.securityId);
          break;
        }
      }
    }

    // 4. Entries. The BUY gate is fully precomputed: this is an indexed read, not an evaluation.
    const candidates: BuyCandidate[] = [];
    for (const runtime of runtimes) {
      const index = frameIndexAt(runtime, date);
      if (index < 0) {
        continue;
      }
      // A buy window restricts every BUY in that stock, whether it opens a position or tops one
      // up. Selling is never restricted by a window.
      if (!isBuyWindowEligible(runtime.input.buyWindows, date)) {
        continue;
      }
      const position = positions.get(runtime.frame.securityId);
      if (!position && openAtDayStart.has(runtime.frame.securityId)) {
        // Closed earlier today; a fresh position waits for the next eligible date.
        continue;
      }
      let best: {
        levelId: string;
        percentage: number;
        settled: boolean;
      } | null = null;
      for (const level of definition.buyLevels) {
        const alreadySettled =
          position?.buyLevelsSettled.has(level.id) ?? false;
        // A settled level is dormant for the rest of the position's life — except on a date that
        // actually deposited new capital. Then, and only then, it is reconsidered against the
        // larger portfolio the contribution created. The engine never rebalances a position merely
        // because its market value drifted below target on an ordinary day.
        if (alreadySettled && !depositedToday) {
          continue;
        }
        if (
          readGate(runtime.gates.buy.get(level.id), index) !== Evaluability.TRUE
        ) {
          // The gate is the level's whole Signal, Trigger included, so a level whose Trigger did
          // not actually fire today cannot top up: a contribution never revives a past event.
          continue;
        }
        if (!best || level.percentage > best.percentage) {
          best = {
            levelId: level.id,
            percentage: level.percentage,
            settled: alreadySettled,
          };
        }
      }
      if (best) {
        candidates.push({
          runtime,
          frameIndex: index,
          levelId: best.levelId,
          percentage: best.percentage,
          isTopUp: position !== undefined,
          isContributionTopUp: best.settled,
        });
      }
    }

    // 5. Order and size. The portfolio value used for sizing is fixed once for the whole date, so
    // the order candidates execute in cannot change the budget each of them is measured against.
    if (candidates.length > 0) {
      candidates.sort(compareCandidates);
      const portfolioValue = cash + positionsValue(positions);
      const fullPositionBudget = portfolioValue * fullPositionFraction;

      for (const candidate of candidates) {
        const close = candidate.runtime.frame.closes[candidate.frameIndex];
        if (close === undefined || !Number.isFinite(close) || close <= 0) {
          continue;
        }
        const frame = candidate.runtime.frame;
        let position = positions.get(frame.securityId);
        if (candidate.isContributionTopUp && !position) {
          // Unreachable: a settled level only exists on an open position. Guarded so a later
          // change cannot turn a contribution top-up into a silent new entry.
          continue;
        }
        if (!position && positions.size >= input.maximumPositions) {
          // No free slot, so no lifecycle begins and nothing is consumed: the strategy can still
          // enter this security on a later date when a slot frees up.
          continue;
        }
        // The budget is measured against the portfolio value *after* today's contribution, which is
        // what lets a deposit lift an already-filled level's target.
        const target = (fullPositionBudget * candidate.percentage) / 100;
        const currentValue = position ? position.shares * close : 0;
        const shortfall = Math.max(target - currentValue, 0);
        const spend = Math.min(shortfall, Math.max(cash, 0));
        if (!position && !(spend > 0)) {
          // Nothing can be bought and there is no position, so no lifecycle begins. Opening one
          // would be a zero-share holding that consumed a slot and a signal for nothing; instead
          // the security stays eligible for a later date on which its signal is TRUE again.
          continue;
        }
        const shares = spend / close;
        if (!position) {
          const epoch = (epochs.get(frame.securityId) ?? 0) + 1;
          epochs.set(frame.securityId, epoch);
          position = {
            securityId: frame.securityId,
            symbol: frame.symbol,
            name: frame.name,
            epoch,
            openedDate: date,
            shares: 0,
            costTotal: 0,
            buyLevelsSettled: new Set<string>(),
            sellLevelsFired: new Set<string>(),
            lastPrice: close,
            lastPriceDate: date,
            realizedPnl: 0,
          };
          positions.set(frame.securityId, position);
        }
        // Consumed for this lifecycle, together with every smaller target.
        //
        // A BUY percentage is an allocation *tier*, not an independent event: reaching the 100%
        // target has satisfied the 25% and 50% ones by definition, so a later price decline must
        // not resurrect the 25% level and buy again on an ordinary day. That was continuous
        // rebalancing arriving through the back door of a multi-level strategy.
        //
        // It settles whether or not anything was bought, and whether the fill was full or as far
        // as the cash went. The opportunity is the signal, not the money: a level that found one
        // cent and a level that found nothing must mean the same thing, or the semantics would
        // turn on the size of the cash balance.
        for (const level of definition.buyLevels) {
          if (level.percentage <= candidate.percentage) {
            position.buyLevelsSettled.add(level.id);
          }
        }
        if (!(spend > 0)) {
          continue;
        }
        applyBuy(position, shares, close, V1_FEE_PER_TRADE);
        cash -= spend + V1_FEE_PER_TRADE;
        position.lastPrice = close;
        position.lastPriceDate = date;
        recordTrade({
          date,
          securityId: position.securityId,
          symbol: position.symbol,
          name: position.name,
          action: "BUY",
          levelId: candidate.levelId,
          levelPercentage: candidate.percentage,
          shares,
          price: close,
          amount: spend,
          fees: V1_FEE_PER_TRADE,
          realizedPnl: null,
          realizedPnlPercent: null,
          cashAfter: cash,
          sharesAfter: position.shares,
          averageCostAfter: averageCost(position),
        });
      }
    }

    // 6. Record the position metric that actually held today, for tomorrow's Trigger.
    for (const position of positions.values()) {
      const runtime = runtimeFor(runtimesById, position.securityId);
      const index = frameIndexAt(runtime, date);
      if (index < 0) {
        continue;
      }
      const close = runtime.frame.closes[index];
      if (close === undefined || !Number.isFinite(close) || close <= 0) {
        continue;
      }
      position.previousSignedReturnPercent = gainPercent(
        close,
        averageCost(position),
      );
      position.previousValueDate = date;
    }

    // 7. Value the day and extend the curves.
    const holdingsValue = positionsValue(positions);
    const totalValue = cash + holdingsValue;
    returnIndex = chainReturnIndex(
      returnIndex,
      previousTotalValue,
      contribution,
      totalValue,
    );
    previousTotalValue = totalValue;
    drawdown.observe(returnIndex);

    const benchmarkIndex = benchmark.indexAt(date);
    if (benchmarkIndex !== null) {
      benchmarkDrawdown.observe(benchmarkIndex);
    }

    equity.push({
      date,
      cash,
      positionsValue: holdingsValue,
      totalValue,
      investedCapital,
      returnIndex,
      benchmarkIndex,
      openPositions: positions.size,
    });
    curve.push({
      date,
      portfolioReturnPercent: indexToPercent(returnIndex),
      benchmarkReturnPercent:
        benchmarkIndex === null ? null : indexToPercent(benchmarkIndex),
    });

    // The first simulated day always checkpoints, so the running page can replace its placeholder
    // with a real curve almost immediately instead of waiting for the first cadence boundary.
    //
    // A year boundary — the last simulated date of a calendar year, and the final date — is a
    // *milestone*: it is the progression a user actually follows on a decades-long run, and it is
    // marked so the worker can persist it even inside its throttle window. There are at most about
    // thirty of them in a V1 run, which is what makes keeping every one of them cheap.
    const isLastDay = day === calendar.length - 1;
    const nextDate = calendar[day + 1];
    const isYearBoundary =
      isLastDay || (nextDate !== undefined && nextDate.slice(0, 4) !== year);
    const isCadence = day === 0 || (day + 1) % checkpointEveryDays === 0;

    if (options.onCheckpoint && !isLastDay && (isCadence || isYearBoundary)) {
      await options.onCheckpoint(
        buildCheckpoint({
          date,
          completedDays: day + 1,
          totalDays: calendar.length,
          cash,
          holdingsValue,
          totalValue,
          investedCapital,
          returnIndex,
          benchmarkIndex,
          maxDrawdownPercent: drawdown.maxDrawdownPercent,
          positions,
          trades,
          curve,
          maxCurvePoints,
          recentTradeCount,
          milestone: isYearBoundary ? year : null,
        }),
      );
    }
  }

  const lastEquity = equity[equity.length - 1] as BacktestEquityPoint;
  const firstDate = calendar[0] as LocalDate;
  const lastDate = calendar[calendar.length - 1] as LocalDate;
  const openPositions = finalPositions(positions, lastEquity.totalValue);
  const unrealizedPnl = openPositions.reduce(
    (total, position) => total + position.unrealizedPnl,
    0,
  );
  const portfolioReturnPercent = indexToPercent(lastEquity.returnIndex);
  const benchmarkReturnPercent =
    lastEquity.benchmarkIndex === null
      ? null
      : indexToPercent(lastEquity.benchmarkIndex);

  const summary: BacktestSummary = {
    firstSimulatedDate: firstDate,
    lastSimulatedDate: lastDate,
    tradingDays: calendar.length,
    investedCapital,
    finalCash: lastEquity.cash,
    finalPositionsValue: lastEquity.positionsValue,
    finalValue: lastEquity.totalValue,
    netProfit: lastEquity.totalValue - investedCapital,
    portfolioReturnPercent,
    benchmarkReturnPercent,
    alphaPercent: alphaPercent(portfolioReturnPercent, benchmarkReturnPercent),
    portfolioCagrPercent: cagrPercent(
      lastEquity.returnIndex,
      firstDate,
      lastDate,
    ),
    maxDrawdownPercent: drawdown.maxDrawdownPercent,
    benchmarkMaxDrawdownPercent:
      input.benchmark === null ? null : benchmarkDrawdown.maxDrawdownPercent,
    realizedPnl,
    unrealizedPnl,
    totalTrades: trades.length,
    buyTrades: trades.filter((trade) => trade.action === "BUY").length,
    sellTrades: trades.filter((trade) => trade.action === "SELL").length,
    finalExitTrades: trades.filter((trade) => trade.action === "FINAL_EXIT")
      .length,
    winningTrades: trades.filter(
      (trade) => trade.realizedPnl !== null && trade.realizedPnl > 0,
    ).length,
    losingTrades: trades.filter(
      (trade) => trade.realizedPnl !== null && trade.realizedPnl < 0,
    ).length,
    openPositions: openPositions.length,
  };

  return { trades, equity, positions: openPositions, summary };
}

function assertInput(input: BacktestExecutionInput): void {
  if (
    !Number.isInteger(input.maximumPositions) ||
    input.maximumPositions <= 0
  ) {
    throw new BacktestExecutionError(
      "maximumPositions must be a positive integer",
    );
  }
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0) {
    throw new BacktestExecutionError(
      "initialCapital must be a positive amount",
    );
  }
  if (
    !Number.isFinite(input.monthlyContribution) ||
    input.monthlyContribution < 0
  ) {
    throw new BacktestExecutionError(
      "monthlyContribution must be zero or a positive amount",
    );
  }
  if (input.startDate > input.endDate) {
    throw new BacktestExecutionError("The period must start before it ends");
  }
  if (input.securities.length === 0) {
    throw new BacktestExecutionError("A backtest needs at least one security");
  }
  if (definitionHasNoBuyLevel(input.definition)) {
    throw new BacktestExecutionError("A strategy needs at least one BUY level");
  }
}

function definitionHasNoBuyLevel(definition: StrategyDefinition): boolean {
  return definition.buyLevels.length === 0;
}

/**
 * Candidate ordering — `CANDIDATE_ORDERING_METHODOLOGY_VERSION`.
 *
 * Top-ups before new entries, then the strongest signal, then a total order on identity so nothing
 * depends on list row order or map iteration order.
 */
function compareCandidates(left: BuyCandidate, right: BuyCandidate): number {
  if (left.isTopUp !== right.isTopUp) {
    return left.isTopUp ? -1 : 1;
  }
  if (left.percentage !== right.percentage) {
    return right.percentage - left.percentage;
  }
  if (left.runtime.frame.symbol !== right.runtime.frame.symbol) {
    return left.runtime.frame.symbol < right.runtime.frame.symbol ? -1 : 1;
  }
  return left.runtime.frame.securityId < right.runtime.frame.securityId
    ? -1
    : 1;
}

function sortedPositions(
  positions: ReadonlyMap<string, PositionState>,
): PositionState[] {
  return [...positions.values()].sort((left, right) => {
    if (left.symbol !== right.symbol) {
      return left.symbol < right.symbol ? -1 : 1;
    }
    return left.securityId < right.securityId ? -1 : 1;
  });
}

function positionsValue(positions: ReadonlyMap<string, PositionState>): number {
  let total = 0;
  for (const position of positions.values()) {
    total += position.shares * position.lastPrice;
  }
  return total;
}

function runtimeFor(
  runtimes: ReadonlyMap<string, SecurityRuntime>,
  securityId: string,
): SecurityRuntime {
  const runtime = runtimes.get(securityId);
  if (!runtime) {
    throw new BacktestExecutionError(
      `No evaluation frame was loaded for security ${securityId}`,
    );
  }
  return runtime;
}

/** Moves a frame cursor forward to the last index at or before `date`. */
function advanceCursor(runtime: SecurityRuntime, date: LocalDate): number {
  const { dates } = runtime.frame;
  let cursor = runtime.cursor;
  while (
    cursor + 1 < dates.length &&
    (dates[cursor + 1] as LocalDate) <= date
  ) {
    cursor += 1;
  }
  return cursor;
}

/**
 * The frame index of `date`, or -1 when this security did not trade that day.
 *
 * `cursor` is the last index at or before `date` after `advanceCursor`, so a mismatch means the
 * date is genuinely absent from this security's axis rather than merely unvisited.
 */
function frameIndexAt(runtime: SecurityRuntime, date: LocalDate): number {
  return runtime.frame.dates[runtime.cursor] === date ? runtime.cursor : -1;
}

/**
 * The close a holding is valued at, or null to carry the previous one forward.
 *
 * A non-positive close is rejected here for the same reason execution and the benchmark cursor
 * reject it: it is not a price. Accepting one would mark the whole position to zero, drive the
 * portfolio value to zero, and absorb the time-weighted index at zero permanently — a total
 * wipeout reported for one bad bar, next to a final value that never changed.
 */
function closeAt(runtime: SecurityRuntime, date: LocalDate): number | null {
  const index = frameIndexAt(runtime, date);
  if (index < 0) {
    return null;
  }
  const close = runtime.frame.closes[index];
  return close !== undefined && Number.isFinite(close) && close > 0
    ? close
    : null;
}

function finalPositions(
  positions: ReadonlyMap<string, PositionState>,
  totalValue: number,
): BacktestOpenPosition[] {
  return sortedPositions(positions).map((position) => {
    const basis = averageCost(position);
    const marketValue = position.shares * position.lastPrice;
    const cost = position.costTotal;
    return {
      securityId: position.securityId,
      symbol: position.symbol,
      name: position.name,
      openedDate: position.openedDate,
      shares: position.shares,
      averageCost: basis,
      lastPrice: position.lastPrice,
      lastPriceDate: position.lastPriceDate,
      marketValue,
      unrealizedPnl: marketValue - cost,
      unrealizedPnlPercent: cost > 0 ? ((marketValue - cost) / cost) * 100 : 0,
      allocationPercent: totalValue > 0 ? (marketValue / totalValue) * 100 : 0,
    };
  });
}

function buildCheckpoint(input: {
  date: LocalDate;
  completedDays: number;
  totalDays: number;
  cash: number;
  holdingsValue: number;
  totalValue: number;
  investedCapital: number;
  returnIndex: number;
  benchmarkIndex: number | null;
  maxDrawdownPercent: number;
  positions: ReadonlyMap<string, PositionState>;
  trades: readonly BacktestTradeRecord[];
  curve: readonly BacktestCurvePoint[];
  maxCurvePoints: number;
  recentTradeCount: number;
  milestone: string | null;
}): BacktestCheckpoint {
  const portfolioReturnPercent = indexToPercent(input.returnIndex);
  const benchmarkReturnPercent =
    input.benchmarkIndex === null ? null : indexToPercent(input.benchmarkIndex);
  const holdings: BacktestCheckpointHolding[] = sortedPositions(
    input.positions,
  ).map((position) => {
    const marketValue = position.shares * position.lastPrice;
    return {
      securityId: position.securityId,
      symbol: position.symbol,
      name: position.name,
      shares: position.shares,
      averageCost: averageCost(position),
      lastPrice: position.lastPrice,
      lastPriceDate: position.lastPriceDate,
      marketValue,
      unrealizedPnlPercent:
        position.costTotal > 0
          ? ((marketValue - position.costTotal) / position.costTotal) * 100
          : 0,
      allocationPercent:
        input.totalValue > 0 ? (marketValue / input.totalValue) * 100 : 0,
    };
  });

  return {
    simulatedThrough: input.date,
    milestone: input.milestone,
    completedDays: input.completedDays,
    totalDays: input.totalDays,
    cash: input.cash,
    positionsValue: input.holdingsValue,
    totalValue: input.totalValue,
    investedCapital: input.investedCapital,
    netProfit: input.totalValue - input.investedCapital,
    portfolioReturnPercent,
    benchmarkReturnPercent,
    alphaPercent: alphaPercent(portfolioReturnPercent, benchmarkReturnPercent),
    maxDrawdownPercent: input.maxDrawdownPercent,
    tradeCount: input.trades.length,
    openPositions: holdings.length,
    curve: downsample(input.curve, input.maxCurvePoints),
    holdings,
    recentTrades: input.trades.slice(-input.recentTradeCount).reverse(),
  };
}
