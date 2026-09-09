import type { StrategyDefinition } from "@intrinsic/contracts";
import {
  isBuyWindowEligible,
  type LocalDate,
  type SecurityId,
} from "@intrinsic/domain";
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
import { ComparisonScenarios } from "./comparison.js";
import {
  DrawdownTracker,
  alphaPercent,
  cagrPercent,
  chainReturnIndex,
  downsample,
  indexToPercent,
} from "./metrics.js";
import type {
  BacktestContextRowDiagnostics,
  BacktestPositionDiagnostics,
  BacktestStateDiagnostics,
} from "./diagnostics.js";
import { V1_FEE_PER_TRADE } from "./methodology.js";
import type {
  BacktestCheckpoint,
  BacktestCheckpointHolding,
  BacktestCurvePoint,
  BacktestEquityPoint,
  BacktestOpenPosition,
  BacktestResult,
  BacktestSecuritySetup,
  BacktestSimulationInput,
  BacktestSimulationOptions,
  BacktestSummary,
  BacktestTradeRecord,
  BacktestWindowInput,
} from "./types.js";
import {
  evaluationFrameContextRow,
  planExecutionWindows,
  withLeadingContextRow,
  type BacktestExecutionWindow,
  type EvaluationFrameContextRow,
} from "./window.js";

const DEFAULT_CHECKPOINT_EVERY_DAYS = 5;
const DEFAULT_MAX_CURVE_POINTS = 360;
const DEFAULT_RECENT_TRADE_COUNT = 10;

export class BacktestExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestExecutionError";
  }
}

/** Everything the loop needs about one list member inside the window being simulated. */
type SecurityRuntime = {
  setup: BacktestSecuritySetup;
  frame: EvaluationFrame;
  gates: StrategyGates;
  /** Cursor into this window's frame; the execution calendar advances it forward only. */
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

/**
 * One deterministic portfolio simulation, consumed one calendar-year window at a time.
 *
 * ```text
 * createBacktestSimulation()
 *      ↓  consumeWindow(2000)   ← only 2000's projections are resident
 *      ↓  consumeWindow(2001)   ← 2000's frames and gates are released
 *      ↓  …
 *      ↓  finish()
 * ```
 *
 * **A year boundary is economically invisible.** It is a data-loading, memory and progress boundary
 * and nothing else: cash, open positions, shares, cost basis, position epochs, settled BUY levels,
 * fired SELL levels, the position-dependent value a Trigger compares against, realized P&L, the
 * trade sequence, the contribution progression, the return and drawdown accumulators and both
 * comparison scenarios all live on this object and flow straight from one window into the next. The
 * only thing a window replaces is which rows are in memory. See
 * `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md`.
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
 * 6. record the day's equity point and the three comparison values.
 *
 * Nothing reads a clock, no iteration depends on hash order, and checkpoints are pure observation,
 * so the same input always produces the same output.
 */
export class BacktestSimulation {
  readonly windows: readonly BacktestExecutionWindow[];

  private readonly definition: StrategyDefinition;
  private readonly calendar: readonly LocalDate[];
  private readonly contributionDates: ReadonlySet<LocalDate>;
  private readonly fullPositionFraction: number;
  private readonly benchmark: BenchmarkCursor;
  private readonly scenarios = new ComparisonScenarios();

  private readonly positions = new Map<SecurityId, PositionState>();
  private readonly epochs = new Map<SecurityId, number>();
  private readonly trades: BacktestTradeRecord[] = [];
  private readonly equity: BacktestEquityPoint[] = [];
  private readonly curve: BacktestCurvePoint[] = [];
  private readonly drawdown = new DrawdownTracker();
  private readonly benchmarkDrawdown = new DrawdownTracker();

  /** The one preceding eligible row per security, carried across the window boundary. */
  private readonly contextRows = new Map<
    SecurityId,
    EvaluationFrameContextRow
  >();
  private runtimes: SecurityRuntime[] = [];
  private runtimesById = new Map<SecurityId, SecurityRuntime>();

  private cash: number;
  private investedCapital: number;
  private returnIndex = 1;
  private previousTotalValue: number;
  private realizedPnl = 0;
  private sequence = 0;
  private completedDays = 0;
  private nextWindowIndex = 0;

  private readonly checkpointEveryDays: number;
  private readonly maxCurvePoints: number;
  private readonly recentTradeCount: number;

  constructor(
    private readonly input: BacktestSimulationInput,
    private readonly options: BacktestSimulationOptions = {},
  ) {
    assertInput(input);

    if (input.executionCalendar.length === 0) {
      throw new BacktestExecutionError(
        "A backtest needs its execution calendar: the dates it simulates are methodology, not a " +
          "consequence of which securities happened to load",
      );
    }
    this.calendar = buildExecutionCalendar(
      input.startDate,
      input.endDate,
      input.executionCalendar,
    );
    if (this.calendar.length === 0) {
      throw new BacktestExecutionError(
        "The requested period contains no eligible trading day for any security in the list",
      );
    }

    this.windows = planExecutionWindows(
      this.calendar,
      input.startDate,
      input.endDate,
    );
    this.contributionDates = buildContributionDates(this.calendar);
    this.definition = input.definition;
    this.fullPositionFraction = 1 / input.maximumPositions;
    this.benchmark = new BenchmarkCursor(input.benchmark);

    this.cash = input.initialCapital;
    this.investedCapital = input.initialCapital;
    this.previousTotalValue = input.initialCapital;
    // The initial capital is an external cash flow like any other: all three scenarios receive it,
    // and the benchmark scenario invests it at the first close it can be priced against.
    this.scenarios.fund(input.initialCapital);

    this.checkpointEveryDays =
      options.checkpointEveryDays ?? DEFAULT_CHECKPOINT_EVERY_DAYS;
    this.maxCurvePoints = options.maxCurvePoints ?? DEFAULT_MAX_CURVE_POINTS;
    this.recentTradeCount =
      options.recentTradeCount ?? DEFAULT_RECENT_TRADE_COUNT;
  }

  /** Simulated trading dates completed so far, and how many the whole run holds. */
  get progress(): { completedDays: number; totalDays: number } {
    return {
      completedDays: this.completedDays,
      totalDays: this.calendar.length,
    };
  }

  /**
   * Simulates one calendar-year window from the projections loaded for it.
   *
   * `input.frames` carries one frame per run security, **in the run's own order**, so a loader that
   * silently dropped or reordered a security fails here rather than producing a quietly different
   * result. A security with no rows in this window supplies an empty frame: that is the ordinary
   * shape of a year before a listing or after a history ends, and its holdings simply carry forward
   * at their most recent close.
   */
  async consumeWindow(
    window: BacktestExecutionWindow,
    input: BacktestWindowInput,
  ): Promise<void> {
    const expected = this.windows[this.nextWindowIndex];
    if (!expected || expected.index !== window.index) {
      throw new BacktestExecutionError(
        `Backtest windows must be consumed in order: expected ${
          expected ? expected.year : "no further window"
        }, received ${window.year}`,
      );
    }
    this.nextWindowIndex += 1;
    this.openWindow(input.frames);
    await this.observeWindowOpened(window);
    const from = { trades: this.trades.length, equity: this.equity.length };
    for (const date of window.dates) {
      await this.simulateDate(date);
    }
    this.closeWindow();
    await this.observeWindowClosed(window, from);
  }

  /**
   * Simulates the whole period from one whole-period projection per security.
   *
   * The continuous reference path, and the only caller that binds frames once. It exists so a test
   * can execute exactly the same day loop over undivided data and compare it with the windowed
   * result — the equivalence the annual refactor has to hold, expressed as two ways of feeding one
   * engine rather than two engines.
   */
  async consumeWholePeriod(frames: readonly EvaluationFrame[]): Promise<void> {
    if (this.nextWindowIndex !== 0) {
      throw new BacktestExecutionError(
        "The whole period can only be consumed by a simulation that has not started",
      );
    }
    this.nextWindowIndex = this.windows.length;
    // One synthetic window spanning the run, so an observer sees the same shape either way.
    const window: BacktestExecutionWindow = {
      year: (this.calendar[0] as LocalDate).slice(0, 4),
      index: 0,
      from: this.input.startDate,
      to: this.input.endDate,
      dates: this.calendar,
    };
    this.openWindow(frames);
    await this.observeWindowOpened(window);
    const from = { trades: this.trades.length, equity: this.equity.length };
    for (const date of this.calendar) {
      await this.simulateDate(date);
    }
    this.closeWindow();
    await this.observeWindowClosed(window, from);
  }

  /**
   * The run's durable result.
   *
   * Refuses a simulation that has not consumed every window: a partially simulated run is not a
   * completed backtest, and handing back a summary for the years that happened to finish would be
   * indistinguishable from one for the period the user asked for.
   */
  finish(): BacktestResult {
    if (this.nextWindowIndex !== this.windows.length) {
      throw new BacktestExecutionError(
        `The simulation has consumed ${this.nextWindowIndex} of ${this.windows.length} execution ` +
          "windows; a partially simulated run has no result",
      );
    }
    const lastEquity = this.equity[this.equity.length - 1] as BacktestEquityPoint;
    const firstDate = this.calendar[0] as LocalDate;
    const lastDate = this.calendar[this.calendar.length - 1] as LocalDate;
    const openPositions = finalPositions(this.positions, lastEquity.totalValue);
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
      tradingDays: this.calendar.length,
      investedCapital: this.investedCapital,
      finalCash: lastEquity.cash,
      finalPositionsValue: lastEquity.positionsValue,
      finalValue: lastEquity.totalValue,
      netProfit: lastEquity.totalValue - this.investedCapital,
      portfolioReturnPercent,
      benchmarkReturnPercent,
      alphaPercent: alphaPercent(
        portfolioReturnPercent,
        benchmarkReturnPercent,
      ),
      portfolioCagrPercent: cagrPercent(
        lastEquity.returnIndex,
        firstDate,
        lastDate,
      ),
      maxDrawdownPercent: this.drawdown.maxDrawdownPercent,
      benchmarkMaxDrawdownPercent:
        this.input.benchmark === null
          ? null
          : this.benchmarkDrawdown.maxDrawdownPercent,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      totalTrades: this.trades.length,
      buyTrades: this.trades.filter((trade) => trade.action === "BUY").length,
      sellTrades: this.trades.filter((trade) => trade.action === "SELL").length,
      finalExitTrades: this.trades.filter(
        (trade) => trade.action === "FINAL_EXIT",
      ).length,
      winningTrades: this.trades.filter(
        (trade) => trade.realizedPnl !== null && trade.realizedPnl > 0,
      ).length,
      losingTrades: this.trades.filter(
        (trade) => trade.realizedPnl !== null && trade.realizedPnl < 0,
      ).length,
      openPositions: openPositions.length,
    };

    return {
      trades: this.trades,
      equity: this.equity,
      positions: openPositions,
      summary,
    };
  }

  /**
   * Binds this window's frames, splicing in the one preceding row each security carried over.
   *
   * Gates are rebuilt per window because they are indexed by frame position. They are the market
   * half of a Signal evaluated over resident rows — pure observation of data the canonical loader
   * already materialized with its own warm-up — so recomputing them over a year's rows reads the
   * same values the whole-period gate would have held at those dates.
   */
  private openWindow(frames: readonly EvaluationFrame[]): void {
    const setups = this.input.securities;
    if (frames.length !== setups.length) {
      throw new BacktestExecutionError(
        `A backtest window needs one frame per security: expected ${setups.length}, received ${frames.length}`,
      );
    }

    this.runtimes = setups.map((setup, index) => {
      const frame = frames[index] as EvaluationFrame;
      if (frame.securityId !== setup.securityId) {
        throw new BacktestExecutionError(
          `Backtest window frame ${index} is ${frame.securityId}, expected ${setup.securityId}`,
        );
      }
      const windowed = withLeadingContextRow(
        frame,
        this.contextRows.get(setup.securityId) ?? null,
      );
      return {
        setup,
        frame: windowed,
        gates: buildStrategyGates(this.definition, windowed),
        cursor: 0,
      };
    });
    this.runtimesById = new Map(
      this.runtimes.map((runtime) => [runtime.setup.securityId, runtime]),
    );
  }

  /**
   * Retains one row per security and drops the window's frames and gates.
   *
   * What survives is a single date, close and operand reading per security — the Trigger context
   * the next window needs — rather than a year of columns, which is what makes a thirty-year run
   * cost one year of resident projection instead of thirty.
   */
  private closeWindow(): void {
    for (const runtime of this.runtimes) {
      const row = evaluationFrameContextRow(runtime.frame);
      if (row) {
        this.contextRows.set(runtime.setup.securityId, row);
      }
    }
    this.runtimes = [];
    this.runtimesById = new Map();
  }

  private async simulateDate(date: LocalDate): Promise<void> {
    const { definition, positions, runtimesById } = this;
    if (this.calendar[this.completedDays] !== date) {
      // A window whose dates do not continue the run's own calendar would silently simulate a
      // different axis than the one the snapshot pinned. Cheap to check, and impossible to notice
      // afterwards from the numbers alone.
      throw new BacktestExecutionError(
        `Backtest window date ${date} does not continue the execution calendar at position ${this.completedDays}`,
      );
    }

    // The initial capital is the run's first external cash flow, applied in the constructor and
    // spendable on this date. Reporting it here is what gives a diagnostic observer one funding
    // series it can compare against the snapshot, rather than one deposit type it has to infer.
    if (this.completedDays === 0) {
      this.options.diagnostics?.onFunding?.({
        date,
        type: "INITIAL_CAPITAL",
        amount: this.input.initialCapital,
        cashAfter: this.cash,
        investedCapitalAfter: this.investedCapital,
      });
    }

    // 1. Cash in.
    const contribution =
      this.input.monthlyContribution > 0 && this.contributionDates.has(date)
        ? this.input.monthlyContribution
        : 0;
    const depositedToday = contribution > 0;
    if (depositedToday) {
      this.cash += contribution;
      this.investedCapital += contribution;
      // The same deposit, on the same date, reaches the two comparison scenarios: the S&P 500
      // portfolio buys more shares with it and the Cash baseline simply holds it.
      this.scenarios.fund(contribution);
      this.options.diagnostics?.onFunding?.({
        date,
        type: "MONTHLY_CONTRIBUTION",
        amount: contribution,
        cashAfter: this.cash,
        investedCapitalAfter: this.investedCapital,
      });
    }

    // 2. Advance every frame cursor to this date and mark holdings.
    for (const runtime of this.runtimes) {
      runtime.cursor = advanceCursor(runtime, date);
    }
    for (const position of positions.values()) {
      const runtime = runtimesById.get(position.securityId);
      const close = runtime ? closeAt(runtime, date) : null;
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
      const runtime = runtimesById.get(position.securityId);
      if (!runtime) {
        continue;
      }
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
          this.cash += shares * close - V1_FEE_PER_TRADE;
          this.realizedPnl += pnl;
          this.recordTrade({
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
            cashAfter: this.cash,
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
        this.cash += shares * close - V1_FEE_PER_TRADE;
        this.realizedPnl += pnl;
        position.sellLevelsFired.add(level.id);
        this.recordTrade({
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
          cashAfter: this.cash,
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
    for (const runtime of this.runtimes) {
      const index = frameIndexAt(runtime, date);
      if (index < 0) {
        continue;
      }
      // A buy window restricts every BUY in that stock, whether it opens a position or tops one
      // up. Selling is never restricted by a window.
      if (!isBuyWindowEligible(runtime.setup.buyWindows, date)) {
        continue;
      }
      const position = positions.get(runtime.setup.securityId);
      if (!position && openAtDayStart.has(runtime.setup.securityId)) {
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
      const portfolioValue = this.cash + positionsValue(positions);
      const fullPositionBudget = portfolioValue * this.fullPositionFraction;

      for (const candidate of candidates) {
        const close = candidate.runtime.frame.closes[candidate.frameIndex];
        if (close === undefined || !Number.isFinite(close) || close <= 0) {
          continue;
        }
        const setup = candidate.runtime.setup;
        let position = positions.get(setup.securityId);
        if (candidate.isContributionTopUp && !position) {
          // Unreachable: a settled level only exists on an open position. Guarded so a later
          // change cannot turn a contribution top-up into a silent new entry.
          continue;
        }
        if (!position && positions.size >= this.input.maximumPositions) {
          // No free slot, so no lifecycle begins and nothing is consumed: the strategy can still
          // enter this security on a later date when a slot frees up.
          continue;
        }
        // The budget is measured against the portfolio value *after* today's contribution, which is
        // what lets a deposit lift an already-filled level's target.
        const target = (fullPositionBudget * candidate.percentage) / 100;
        const currentValue = position ? position.shares * close : 0;
        const shortfall = Math.max(target - currentValue, 0);
        const spend = Math.min(shortfall, Math.max(this.cash, 0));
        if (!position && !(spend > 0)) {
          // Nothing can be bought and there is no position, so no lifecycle begins. Opening one
          // would be a zero-share holding that consumed a slot and a signal for nothing; instead
          // the security stays eligible for a later date on which its signal is TRUE again.
          continue;
        }
        const shares = spend / close;
        if (!position) {
          const epoch = (this.epochs.get(setup.securityId) ?? 0) + 1;
          this.epochs.set(setup.securityId, epoch);
          position = {
            securityId: setup.securityId,
            symbol: setup.symbol,
            name: setup.name,
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
          positions.set(setup.securityId, position);
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
        this.cash -= spend + V1_FEE_PER_TRADE;
        position.lastPrice = close;
        position.lastPriceDate = date;
        this.recordTrade({
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
          cashAfter: this.cash,
          sharesAfter: position.shares,
          averageCostAfter: averageCost(position),
        });
      }
    }

    // 6. Record the position metric that actually held today, for tomorrow's Trigger.
    for (const position of positions.values()) {
      const runtime = runtimesById.get(position.securityId);
      if (!runtime) {
        continue;
      }
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
    const totalValue = this.cash + holdingsValue;
    this.returnIndex = chainReturnIndex(
      this.returnIndex,
      this.previousTotalValue,
      contribution,
      totalValue,
    );
    this.previousTotalValue = totalValue;
    this.drawdown.observe(this.returnIndex);

    // One read of the benchmark's close in effect today, used twice: for the percentage-growth
    // index every existing summary metric is built on, and to mark the funded absolute comparison
    // portfolio. The comparison scenario cannot disagree with the index about which bar applied.
    const benchmarkClose = this.benchmark.closeAt(date);
    const benchmarkIndex = this.benchmark.indexFor(benchmarkClose);
    if (benchmarkIndex !== null) {
      this.benchmarkDrawdown.observe(benchmarkIndex);
    }
    const benchmarkValue = this.scenarios.markBenchmark(benchmarkClose);
    const cashBaselineValue = this.scenarios.cashBaselineValue;

    this.equity.push({
      date,
      cash: this.cash,
      positionsValue: holdingsValue,
      totalValue,
      investedCapital: this.investedCapital,
      returnIndex: this.returnIndex,
      benchmarkIndex,
      benchmarkValue,
      cashBaselineValue,
      openPositions: positions.size,
    });
    this.curve.push({
      date,
      portfolioReturnPercent: indexToPercent(this.returnIndex),
      benchmarkReturnPercent:
        benchmarkIndex === null ? null : indexToPercent(benchmarkIndex),
      strategyValue: totalValue,
      benchmarkValue,
      cashBaselineValue,
    });

    this.completedDays += 1;

    // The first simulated day always checkpoints, so the running page can replace its placeholder
    // with a real curve almost immediately instead of waiting for the first cadence boundary.
    //
    // A year boundary — the last simulated date of a calendar year, and the final date — is a
    // *milestone*: it is the progression a user actually follows on a decades-long run, and it is
    // marked so the worker can persist it even inside its throttle window. There are at most about
    // thirty of them in a V1 run, which is what makes keeping every one of them cheap. It is also
    // the boundary at which the completed prefix of the curve becomes visible to a running page.
    const nextDate = this.calendar[this.completedDays];
    const isLastDay = nextDate === undefined;
    const year = date.slice(0, 4);
    // Derived from the run's own calendar rather than from the window, so the whole-period and
    // windowed paths mark exactly the same days — a year boundary is a property of the calendar,
    // not of how much of it happens to be resident.
    const isYearBoundary = isLastDay || nextDate.slice(0, 4) !== year;
    const isCadence =
      this.completedDays === 1 ||
      this.completedDays % this.checkpointEveryDays === 0;

    if (
      this.options.onCheckpoint &&
      !isLastDay &&
      (isCadence || isYearBoundary)
    ) {
      await this.options.onCheckpoint(
        this.buildCheckpoint({
          date,
          holdingsValue,
          totalValue,
          benchmarkIndex,
          benchmarkValue,
          cashBaselineValue,
          milestone: isYearBoundary ? year : null,
        }),
      );
    }
  }

  /**
   * Hands an observer the frames this window is actually simulated from.
   *
   * After {@link openWindow}, so what it sees is the **bound** frame with the retained context row
   * spliced in — the rows a Trigger reads at `index - 1`, which the loader's own output does not
   * contain.
   */
  private async observeWindowOpened(
    window: BacktestExecutionWindow,
  ): Promise<void> {
    const observer = this.options.diagnostics;
    if (!observer?.onWindowOpened) {
      return;
    }
    await observer.onWindowOpened({
      window,
      frames: this.runtimes.map((runtime) => runtime.frame),
    });
  }

  /**
   * Hands an observer what this window produced and the state the next one continues from.
   *
   * Called after {@link closeWindow}, so the retained context rows it reports are the ones the next
   * window will splice in. The rows are sliced from the run's own arrays rather than copied out of
   * a parallel record, so a capture cannot drift from what the result will contain.
   */
  private async observeWindowClosed(
    window: BacktestExecutionWindow,
    from: { trades: number; equity: number },
  ): Promise<void> {
    const observer = this.options.diagnostics;
    if (!observer?.onWindowClosed) {
      return;
    }
    await observer.onWindowClosed({
      window,
      trades: this.trades.slice(from.trades),
      equity: this.equity.slice(from.equity),
      state: this.describeState(),
    });
  }

  /**
   * An allowlisted, plain-data view of the state a window boundary carries.
   *
   * Explicitly enumerated rather than serialized, so a private field added later cannot silently
   * start leaving the process, and so nothing about a `Map`, a `Set` or a class identity has to be
   * understood by whatever writes it out. Purely a read: the next window continues from the live
   * state, never from this.
   */
  describeState(): BacktestStateDiagnostics {
    const lastEquity = this.equity[this.equity.length - 1] ?? null;
    const positions: BacktestPositionDiagnostics[] = sortedPositions(
      this.positions,
    ).map((position) => ({
      securityId: position.securityId,
      symbol: position.symbol,
      epoch: position.epoch,
      openedDate: position.openedDate,
      shares: position.shares,
      costTotal: position.costTotal,
      averageCost: averageCost(position),
      lastPrice: position.lastPrice,
      lastPriceDate: position.lastPriceDate,
      realizedPnl: position.realizedPnl,
      buyLevelsSettled: [...position.buyLevelsSettled].sort(),
      sellLevelsFired: [...position.sellLevelsFired].sort(),
      previousSignedReturnPercent:
        position.previousSignedReturnPercent ?? null,
      previousValueDate: position.previousValueDate ?? null,
    }));

    const contextRows: BacktestContextRowDiagnostics[] = this.input.securities
      .map((setup) => {
        const row = this.contextRows.get(setup.securityId);
        return row
          ? {
              securityId: setup.securityId,
              symbol: setup.symbol,
              date: row.date,
              close: row.close,
              values: row.values,
            }
          : null;
      })
      .filter((row): row is BacktestContextRowDiagnostics => row !== null);

    return {
      simulatedThrough: lastEquity?.date ?? null,
      completedDays: this.completedDays,
      totalDays: this.calendar.length,
      cash: this.cash,
      positionsValue: lastEquity?.positionsValue ?? 0,
      totalValue: lastEquity?.totalValue ?? this.cash,
      investedCapital: this.investedCapital,
      realizedPnl: this.realizedPnl,
      returnIndex: this.returnIndex,
      previousTotalValue: this.previousTotalValue,
      maxDrawdownPercent: this.drawdown.maxDrawdownPercent,
      benchmarkMaxDrawdownPercent:
        this.input.benchmark === null
          ? null
          : this.benchmarkDrawdown.maxDrawdownPercent,
      tradeSequence: this.sequence,
      tradeCount: this.trades.length,
      equityPointCount: this.equity.length,
      positions,
      positionEpochs: [...this.epochs.entries()]
        .map(([securityId, epoch]) => ({ securityId, epoch }))
        .sort((left, right) =>
          left.securityId < right.securityId ? -1 : 1,
        ),
      comparison: {
        benchmarkShares: this.scenarios.benchmarkShares,
        benchmarkPendingCapital: this.scenarios.pendingCapital,
        cashBaselineValue: this.scenarios.cashBaselineValue,
      },
      contextRows,
    };
  }

  private recordTrade(trade: Omit<BacktestTradeRecord, "sequence">): void {
    this.sequence += 1;
    this.trades.push({ sequence: this.sequence, ...trade });
  }

  private buildCheckpoint(input: {
    date: LocalDate;
    holdingsValue: number;
    totalValue: number;
    benchmarkIndex: number | null;
    benchmarkValue: number | null;
    cashBaselineValue: number;
    milestone: string | null;
  }): BacktestCheckpoint {
    const portfolioReturnPercent = indexToPercent(this.returnIndex);
    const benchmarkReturnPercent =
      input.benchmarkIndex === null
        ? null
        : indexToPercent(input.benchmarkIndex);
    const holdings: BacktestCheckpointHolding[] = sortedPositions(
      this.positions,
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
      completedDays: this.completedDays,
      totalDays: this.calendar.length,
      cash: this.cash,
      positionsValue: input.holdingsValue,
      totalValue: input.totalValue,
      investedCapital: this.investedCapital,
      netProfit: input.totalValue - this.investedCapital,
      portfolioReturnPercent,
      benchmarkReturnPercent,
      alphaPercent: alphaPercent(
        portfolioReturnPercent,
        benchmarkReturnPercent,
      ),
      maxDrawdownPercent: this.drawdown.maxDrawdownPercent,
      benchmarkValue: input.benchmarkValue,
      cashBaselineValue: input.cashBaselineValue,
      tradeCount: this.trades.length,
      openPositions: holdings.length,
      curve: downsample(this.curve, this.maxCurvePoints),
      holdings,
      recentTrades: this.trades.slice(-this.recentTradeCount).reverse(),
    };
  }
}

/** Creates a simulation that consumes calendar-year windows. See {@link BacktestSimulation}. */
export function createBacktestSimulation(
  input: BacktestSimulationInput,
  options: BacktestSimulationOptions = {},
): BacktestSimulation {
  return new BacktestSimulation(input, options);
}

function assertInput(input: BacktestSimulationInput): void {
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
  if (input.definition.buyLevels.length === 0) {
    throw new BacktestExecutionError("A strategy needs at least one BUY level");
  }
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
  if (left.runtime.setup.symbol !== right.runtime.setup.symbol) {
    return left.runtime.setup.symbol < right.runtime.setup.symbol ? -1 : 1;
  }
  return left.runtime.setup.securityId < right.runtime.setup.securityId
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
