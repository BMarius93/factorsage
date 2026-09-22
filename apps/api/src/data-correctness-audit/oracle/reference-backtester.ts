import {
  SHARE_STEP,
  ZERO,
  dec,
  money,
  moneyText,
  price,
  priceText,
  sharesDown,
  sharesText,
  type Dec,
} from "./decimal";
import {
  gainPercent,
  or,
  signalValue,
  type MarketRow,
  type PositionReadings,
  type Tri,
} from "./predicates";
import type { OracleStrategy } from "./strategy-model";

/**
 * The independent reference backtester.
 *
 * Intentionally simple and slow: one pass over the execution calendar, every predicate evaluated
 * from the raw rows on the day it is needed, no precomputed gates, no calendar-year windows, no
 * cursors. It follows the product and methodology documents
 * (`ai/product/backtests.md`, `ai/product/strategies.md`, `ai/architecture/backtest-execution.md`)
 * and imports nothing from the production engine.
 *
 * Per date, in the documented order:
 *   1. monthly contribution on the first calendar date of a month (never the run's first date);
 *   2. mark every holding at its most recent observed close;
 *   3. exits, per open position in (symbol, security id) order — FINAL EXIT (any Exit Rule) first,
 *      then SELL levels in definition order, each at most once per position lifecycle;
 *   4. entries — for every security with a row today whose buy window admits the date, the
 *      strongest TRUE BUY level not yet settled (settled levels reconsidered only on a deposit
 *      date); a security whose position closed today cannot re-enter today;
 *   5. candidates ordered top-ups first, percentage descending, symbol, security id; sized against
 *      one portfolio value fixed for the date; slot cap and cash enforced;
 *   6. on the final date only, every open position is sold at its most recent observed close;
 *   7. record the position metric that held today, the equity row and the comparison scenarios.
 */

export type OracleBuyWindow = { startDate: string; endDate: string | null };

export type OracleSecurity = {
  securityId: string;
  symbol: string;
  buyWindowMode: "FULL" | "CUSTOM";
  buyWindows: readonly OracleBuyWindow[];
  /** Every eligible row the security has, ascending, including rows before the period. */
  rows: readonly MarketRow[];
};

export type OracleBacktestInput = {
  strategy: OracleStrategy;
  securities: readonly OracleSecurity[];
  /** The authoritative execution calendar (any range; restricted to the period here). */
  calendar: readonly string[];
  startDate: string;
  endDate: string;
  initialCapital: number;
  monthlyContribution: number;
  maximumPositions: number;
  benchmark: { dates: readonly string[]; closes: readonly number[] } | null;
};

export type OracleTrade = {
  sequence: number;
  date: string;
  securityId: string;
  symbol: string;
  action: "BUY" | "SELL" | "FINAL_EXIT";
  source: "STRATEGY" | "END_OF_BACKTEST";
  levelId: string | null;
  exitRuleId: string | null;
  levelPercentage: number | null;
  shares: string;
  price: string;
  amount: string;
  fees: string;
  realizedPnl: string | null;
  /** A float ratio, as the engine reports it; stored at numeric(20,8). */
  realizedPnlPercent: number | null;
  cashAfter: string;
  sharesAfter: string;
  averageCostAfter: string | null;
};

export type OracleEquityRow = {
  date: string;
  cash: string;
  positionsValue: string;
  totalValue: string;
  investedCapital: string;
  returnIndex: number;
  benchmarkIndex: number | null;
  benchmarkValue: string | null;
  cashBaselineValue: string;
  openPositions: number;
};

export type OracleSummary = {
  firstSimulatedDate: string;
  lastSimulatedDate: string;
  tradingDays: number;
  investedCapital: string;
  finalCash: string;
  finalPositionsValue: string;
  finalValue: string;
  netProfit: string;
  portfolioReturnPercent: number;
  benchmarkReturnPercent: number | null;
  alphaPercent: number | null;
  portfolioCagrPercent: number | null;
  maxDrawdownPercent: number;
  benchmarkMaxDrawdownPercent: number | null;
  realizedPnl: string;
  unrealizedPnl: string;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  finalExitTrades: number;
  winningTrades: number;
  losingTrades: number;
  openPositions: number;
};

/** Human-readable evidence for one executed trade: what the oracle saw and why it acted. */
export type OracleTradeEvidence = {
  sequence: number;
  date: string;
  symbol: string;
  action: string;
  reason: string;
  eligible: boolean | null;
  signal: Tri | null;
  executionPrice: string;
  cashBefore: string;
  cashAfter: string;
  sharesBefore: string;
  sharesTraded: string;
  sharesAfter: string;
  amount: string;
  /** BUY sizing inputs, float, exactly as the methodology sizes them. */
  sizing?: {
    portfolioValue: number;
    fullPositionBudget: number;
    target: number;
    currentValue: number;
    shortfall: number;
    cashLimited: boolean;
  };
};

export type OracleBacktestResult = {
  calendar: string[];
  trades: OracleTrade[];
  equity: OracleEquityRow[];
  summary: OracleSummary;
  evidence: OracleTradeEvidence[];
  contributionDates: string[];
  /** Per security, the dates on which the buy window admitted a BUY and a row existed. */
  decisionsEvaluated: number;
};

type Position = {
  securityId: string;
  symbol: string;
  shares: Dec;
  averageCost: Dec;
  costTotal: Dec;
  settledBuyLevels: Set<string>;
  firedSellLevels: Set<string>;
  lastPrice: number;
  previousGain: number | null;
  previousGainDate: string | null;
};

function eligibleForBuy(security: OracleSecurity, date: string): boolean {
  if (security.buyWindowMode === "FULL") {
    return true;
  }
  for (const window of security.buyWindows) {
    if (
      window.startDate <= date &&
      (window.endDate === null || date <= window.endDate)
    ) {
      return true;
    }
  }
  return false;
}

function validClose(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function bySymbolThenId(
  left: { symbol: string; securityId: string },
  right: { symbol: string; securityId: string },
): number {
  if (left.symbol !== right.symbol) {
    return left.symbol < right.symbol ? -1 : 1;
  }
  return left.securityId < right.securityId
    ? -1
    : left.securityId > right.securityId
      ? 1
      : 0;
}

class RowIndex {
  private readonly byDate = new Map<string, number>();
  constructor(readonly rows: readonly MarketRow[]) {
    rows.forEach((row, index) => {
      if (index > 0 && !(rows[index - 1]!.date < row.date)) {
        throw new Error(
          `oracle: rows for a security are not strictly ascending at ${row.date}`,
        );
      }
      this.byDate.set(row.date, index);
    });
  }
  at(date: string): { row: MarketRow; previous: MarketRow | null } | null {
    const index = this.byDate.get(date);
    if (index === undefined) {
      return null;
    }
    return {
      row: this.rows[index]!,
      previous: index > 0 ? this.rows[index - 1]! : null,
    };
  }
}

export function runReferenceBacktest(
  input: OracleBacktestInput,
): OracleBacktestResult {
  const { strategy } = input;
  const calendar = [...new Set(input.calendar)]
    .filter((date) => date >= input.startDate && date <= input.endDate)
    .sort();
  if (calendar.length === 0) {
    throw new Error("oracle: the period contains no execution date");
  }
  const securities = [...input.securities].sort(bySymbolThenId);
  const rowIndex = new Map(
    securities.map((security) => [
      security.securityId,
      new RowIndex(security.rows),
    ]),
  );

  let cash = money(input.initialCapital);
  let invested = money(input.initialCapital);
  let realized = ZERO;
  let returnIndex = 1;
  let previousTotal = input.initialCapital;
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdown = 0;
  let benchmarkPeak = Number.NEGATIVE_INFINITY;
  let benchmarkMaxDrawdown = 0;
  let benchmarkBase: number | null = null;
  let benchmarkShares = ZERO;
  let benchmarkPending = money(input.initialCapital);
  let cashBaseline = money(input.initialCapital);
  let benchmarkCursor = -1;

  const positions = new Map<string, Position>();
  const trades: OracleTrade[] = [];
  const equity: OracleEquityRow[] = [];
  const evidence: OracleTradeEvidence[] = [];
  const contributionDates: string[] = [];
  let decisionsEvaluated = 0;

  const positionsValue = (): Dec => {
    let total = ZERO;
    for (const position of positions.values()) {
      total = total.plus(
        money(position.shares.times(price(position.lastPrice))),
      );
    }
    return money(total);
  };

  const record = (trade: Omit<OracleTrade, "sequence">): OracleTrade => {
    const full = { sequence: trades.length + 1, ...trade };
    trades.push(full);
    return full;
  };

  const sell = (
    position: Position,
    sharesSold: Dec,
    executionPrice: Dec,
  ): { proceeds: Dec; costRemoved: Dec; pnl: Dec } => {
    const closes = sharesSold.gte(position.shares);
    const costRemoved = closes
      ? position.costTotal
      : money(position.averageCost.times(sharesSold));
    const proceeds = money(executionPrice.times(sharesSold));
    position.shares = closes ? ZERO : position.shares.minus(sharesSold);
    position.costTotal = closes
      ? ZERO
      : money(position.costTotal.minus(costRemoved));
    if (closes) {
      position.averageCost = ZERO;
    }
    const pnl = money(proceeds.minus(costRemoved));
    cash = money(cash.plus(money(proceeds)));
    realized = money(realized.plus(pnl));
    return { proceeds, costRemoved, pnl };
  };

  const pnlPercent = (pnl: Dec, costRemoved: Dec): number | null =>
    costRemoved.gt(0)
      ? (Number(pnl.toString()) / Number(costRemoved.toString())) * 100
      : null;

  const readings = (
    position: Position,
    close: number,
    previousDate: string | null,
  ): PositionReadings => {
    const basis = position.shares.gt(0)
      ? Number(position.averageCost.toString())
      : Number.NaN;
    const previousGain =
      previousDate !== null &&
      position.previousGainDate !== null &&
      position.previousGainDate === previousDate &&
      position.previousGain !== null
        ? position.previousGain
        : Number.NaN;
    return { gain: gainPercent(close, basis), previousGain };
  };

  for (let dayIndex = 0; dayIndex < calendar.length; dayIndex += 1) {
    const date = calendar[dayIndex]!;
    const isLastDay = dayIndex === calendar.length - 1;

    // 1. Contribution.
    let contribution = 0;
    if (
      input.monthlyContribution > 0 &&
      dayIndex > 0 &&
      date.slice(0, 7) !== calendar[dayIndex - 1]!.slice(0, 7)
    ) {
      contribution = input.monthlyContribution;
      const deposit = money(contribution);
      cash = money(cash.plus(deposit));
      invested = money(invested.plus(deposit));
      cashBaseline = money(cashBaseline.plus(deposit));
      benchmarkPending = money(benchmarkPending.plus(deposit));
      contributionDates.push(date);
    }
    const deposited = contribution > 0;

    // 2. Mark holdings.
    for (const position of positions.values()) {
      const today = rowIndex.get(position.securityId)!.at(date);
      if (today && validClose(today.row.close)) {
        position.lastPrice = today.row.close;
      }
    }
    const openAtStart = new Set(positions.keys());

    // 3. Exits.
    for (const position of [...positions.values()].sort(bySymbolThenId)) {
      const today = rowIndex.get(position.securityId)!.at(date);
      if (!today || !validClose(today.row.close)) {
        continue;
      }
      const close = today.row.close;
      const previousDate = today.previous ? today.previous.date : null;
      const position_ = readings(position, close, previousDate);

      if (strategy.finalExit) {
        const results = strategy.finalExit.rules.map((rule) =>
          signalValue(rule.signal, today.row, today.previous, position_),
        );
        if (or(results) === "TRUE") {
          const matchedIndex = results.findIndex((result) => result === "TRUE");
          const cashBefore = cash;
          const sharesBefore = position.shares;
          const executionPrice = price(close);
          const { proceeds, costRemoved, pnl } = sell(
            position,
            position.shares,
            executionPrice,
          );
          const trade = record({
            date,
            securityId: position.securityId,
            symbol: position.symbol,
            action: "FINAL_EXIT",
            source: "STRATEGY",
            levelId: strategy.finalExit.id,
            exitRuleId: strategy.finalExit.rules[matchedIndex]!.id,
            levelPercentage: null,
            shares: sharesText(sharesBefore),
            price: priceText(executionPrice),
            amount: moneyText(proceeds),
            fees: moneyText(ZERO),
            realizedPnl: moneyText(pnl),
            realizedPnlPercent: pnlPercent(pnl, costRemoved),
            cashAfter: moneyText(cash),
            sharesAfter: sharesText(ZERO),
            averageCostAfter: null,
          });
          evidence.push({
            sequence: trade.sequence,
            date,
            symbol: position.symbol,
            action: "FINAL_EXIT",
            reason: `FINAL EXIT rule ${matchedIndex + 1} of ${results.length} TRUE (rules: ${results.join(", ")})`,
            eligible: null,
            signal: "TRUE",
            executionPrice: priceText(executionPrice),
            cashBefore: moneyText(cashBefore),
            cashAfter: moneyText(cash),
            sharesBefore: sharesText(sharesBefore),
            sharesTraded: sharesText(sharesBefore),
            sharesAfter: sharesText(ZERO),
            amount: moneyText(proceeds),
          });
          positions.delete(position.securityId);
          continue;
        }
      }

      for (const level of strategy.sellLevels) {
        if (!position.shares.gt(0) || position.firedSellLevels.has(level.id)) {
          continue;
        }
        const result = signalValue(
          level.signal,
          today.row,
          today.previous,
          position_,
        );
        if (result !== "TRUE") {
          continue;
        }
        const quantity = sharesDown(
          position.shares.times(level.percentage).div(100),
        );
        if (!quantity.gt(0)) {
          continue;
        }
        const cashBefore = cash;
        const sharesBefore = position.shares;
        const executionPrice = price(close);
        const { proceeds, costRemoved, pnl } = sell(
          position,
          quantity,
          executionPrice,
        );
        position.firedSellLevels.add(level.id);
        const trade = record({
          date,
          securityId: position.securityId,
          symbol: position.symbol,
          action: "SELL",
          source: "STRATEGY",
          levelId: level.id,
          exitRuleId: null,
          levelPercentage: level.percentage,
          shares: sharesText(quantity),
          price: priceText(executionPrice),
          amount: moneyText(proceeds),
          fees: moneyText(ZERO),
          realizedPnl: moneyText(pnl),
          realizedPnlPercent: pnlPercent(pnl, costRemoved),
          cashAfter: moneyText(cash),
          sharesAfter: sharesText(position.shares),
          averageCostAfter: position.shares.gt(0)
            ? priceText(position.averageCost)
            : null,
        });
        evidence.push({
          sequence: trade.sequence,
          date,
          symbol: position.symbol,
          action: "SELL",
          reason: `SELL ${level.percentage}% level ${level.id} TRUE; sells ${level.percentage}% of the shares remaining`,
          eligible: null,
          signal: "TRUE",
          executionPrice: priceText(executionPrice),
          cashBefore: moneyText(cashBefore),
          cashAfter: moneyText(cash),
          sharesBefore: sharesText(sharesBefore),
          sharesTraded: sharesText(quantity),
          sharesAfter: sharesText(position.shares),
          amount: moneyText(proceeds),
        });
        if (!position.shares.gt(0)) {
          positions.delete(position.securityId);
          break;
        }
      }
    }

    // 4. Entry candidates.
    type Candidate = {
      security: OracleSecurity;
      row: MarketRow;
      levelId: string;
      percentage: number;
      topUp: boolean;
      contributionTopUp: boolean;
    };
    const candidates: Candidate[] = [];
    for (const security of securities) {
      const today = rowIndex.get(security.securityId)!.at(date);
      if (!today) {
        continue;
      }
      if (!eligibleForBuy(security, date)) {
        continue;
      }
      const position = positions.get(security.securityId);
      if (!position && openAtStart.has(security.securityId)) {
        continue;
      }
      decisionsEvaluated += 1;
      let best: {
        levelId: string;
        percentage: number;
        settled: boolean;
      } | null = null;
      for (const level of strategy.buyLevels) {
        const settled = position
          ? position.settledBuyLevels.has(level.id)
          : false;
        if (settled && !deposited) {
          continue;
        }
        if (
          signalValue(level.signal, today.row, today.previous, null) !== "TRUE"
        ) {
          continue;
        }
        if (!best || level.percentage > best.percentage) {
          best = { levelId: level.id, percentage: level.percentage, settled };
        }
      }
      if (best) {
        candidates.push({
          security,
          row: today.row,
          levelId: best.levelId,
          percentage: best.percentage,
          topUp: position !== undefined,
          contributionTopUp: best.settled,
        });
      }
    }

    // 5. Order and size.
    if (candidates.length > 0) {
      candidates.sort((left, right) => {
        if (left.topUp !== right.topUp) {
          return left.topUp ? -1 : 1;
        }
        if (left.percentage !== right.percentage) {
          return right.percentage - left.percentage;
        }
        return bySymbolThenId(left.security, right.security);
      });
      const portfolioValue =
        Number(cash.toString()) + Number(positionsValue().toString());
      const fullPositionBudget = portfolioValue * (1 / input.maximumPositions);
      for (const candidate of candidates) {
        const close = candidate.row.close;
        if (!validClose(close)) {
          continue;
        }
        let position = positions.get(candidate.security.securityId);
        if (candidate.contributionTopUp && !position) {
          continue;
        }
        if (!position && positions.size >= input.maximumPositions) {
          continue;
        }
        const target = (fullPositionBudget * candidate.percentage) / 100;
        const currentValue = position
          ? Number(position.shares.toString()) * close
          : 0;
        const shortfall = Math.max(target - currentValue, 0);
        const available = cash.gt(0) ? money(cash) : ZERO;
        let spend = money(shortfall);
        const cashLimited = spend.gt(available);
        if (cashLimited) {
          spend = available;
        }
        const executionPrice = price(close);
        let bought = sharesDown(spend.div(executionPrice));
        let amount = money(bought.times(executionPrice));
        while (amount.gt(available) && bought.gt(0)) {
          bought = bought.minus(SHARE_STEP);
          amount = money(bought.times(executionPrice));
        }
        const buyable = bought.gt(0) && amount.gt(0);
        if (!position && !buyable) {
          continue;
        }
        if (!position) {
          position = {
            securityId: candidate.security.securityId,
            symbol: candidate.security.symbol,
            shares: ZERO,
            averageCost: ZERO,
            costTotal: ZERO,
            settledBuyLevels: new Set(),
            firedSellLevels: new Set(),
            lastPrice: close,
            previousGain: null,
            previousGainDate: null,
          };
          positions.set(candidate.security.securityId, position);
        }
        for (const level of strategy.buyLevels) {
          if (level.percentage <= candidate.percentage) {
            position.settledBuyLevels.add(level.id);
          }
        }
        if (!buyable) {
          continue;
        }
        const cashBefore = cash;
        const sharesBefore = position.shares;
        position.costTotal = money(position.costTotal.plus(amount));
        position.shares = position.shares.plus(bought);
        position.averageCost = price(position.costTotal.div(position.shares));
        cash = money(cash.minus(money(amount)));
        position.lastPrice = close;
        const trade = record({
          date,
          securityId: position.securityId,
          symbol: position.symbol,
          action: "BUY",
          source: "STRATEGY",
          levelId: candidate.levelId,
          exitRuleId: null,
          levelPercentage: candidate.percentage,
          shares: sharesText(bought),
          price: priceText(executionPrice),
          amount: moneyText(amount),
          fees: moneyText(ZERO),
          realizedPnl: null,
          realizedPnlPercent: null,
          cashAfter: moneyText(cash),
          sharesAfter: sharesText(position.shares),
          averageCostAfter: priceText(position.averageCost),
        });
        evidence.push({
          sequence: trade.sequence,
          date,
          symbol: position.symbol,
          action: "BUY",
          reason:
            `BUY ${candidate.percentage}% level ${candidate.levelId} TRUE` +
            (candidate.contributionTopUp
              ? " (contribution-date top-up of a settled level)"
              : candidate.topUp
                ? " (top-up of an open position)"
                : " (new position)"),
          eligible: true,
          signal: "TRUE",
          executionPrice: priceText(executionPrice),
          cashBefore: moneyText(cashBefore),
          cashAfter: moneyText(cash),
          sharesBefore: sharesText(sharesBefore),
          sharesTraded: sharesText(bought),
          sharesAfter: sharesText(position.shares),
          amount: moneyText(amount),
          sizing: {
            portfolioValue,
            fullPositionBudget,
            target,
            currentValue,
            shortfall,
            cashLimited,
          },
        });
      }
    }

    // 6. Terminal liquidation.
    if (isLastDay) {
      for (const position of [...positions.values()].sort(bySymbolThenId)) {
        if (!position.shares.gt(0)) {
          positions.delete(position.securityId);
          continue;
        }
        const cashBefore = cash;
        const sharesBefore = position.shares;
        const executionPrice = price(position.lastPrice);
        const { proceeds, costRemoved, pnl } = sell(
          position,
          position.shares,
          executionPrice,
        );
        const trade = record({
          date,
          securityId: position.securityId,
          symbol: position.symbol,
          action: "SELL",
          source: "END_OF_BACKTEST",
          levelId: null,
          exitRuleId: null,
          levelPercentage: null,
          shares: sharesText(sharesBefore),
          price: priceText(executionPrice),
          amount: moneyText(proceeds),
          fees: moneyText(ZERO),
          realizedPnl: moneyText(pnl),
          realizedPnlPercent: pnlPercent(pnl, costRemoved),
          cashAfter: moneyText(cash),
          sharesAfter: sharesText(ZERO),
          averageCostAfter: null,
        });
        evidence.push({
          sequence: trade.sequence,
          date,
          symbol: position.symbol,
          action: "SELL (END_OF_BACKTEST)",
          reason:
            "final date: every open position is sold at its most recent observed close",
          eligible: null,
          signal: null,
          executionPrice: priceText(executionPrice),
          cashBefore: moneyText(cashBefore),
          cashAfter: moneyText(cash),
          sharesBefore: sharesText(sharesBefore),
          sharesTraded: sharesText(sharesBefore),
          sharesAfter: sharesText(ZERO),
          amount: moneyText(proceeds),
        });
        positions.delete(position.securityId);
      }
    }

    // 7. Position metric that held today, then the day's valuation.
    for (const position of positions.values()) {
      const today = rowIndex.get(position.securityId)!.at(date);
      if (!today || !validClose(today.row.close)) {
        continue;
      }
      const basis = position.shares.gt(0)
        ? Number(position.averageCost.toString())
        : Number.NaN;
      position.previousGain = gainPercent(today.row.close, basis);
      position.previousGainDate = date;
    }

    const holdings = positionsValue();
    const totalExact = money(cash.plus(holdings));
    const total = Number(totalExact.toString());
    const base = previousTotal + contribution;
    if (base > 0 && Number.isFinite(total)) {
      returnIndex = returnIndex * (total / base);
    }
    previousTotal = total;
    if (Number.isFinite(returnIndex) && returnIndex > 0) {
      if (returnIndex > peak) {
        peak = returnIndex;
      } else {
        maxDrawdown = Math.max(maxDrawdown, (1 - returnIndex / peak) * 100);
      }
    }

    let benchmarkClose: number | null = null;
    if (input.benchmark) {
      const { dates, closes } = input.benchmark;
      while (
        benchmarkCursor + 1 < dates.length &&
        dates[benchmarkCursor + 1]! <= date
      ) {
        benchmarkCursor += 1;
      }
      if (benchmarkCursor >= 0) {
        const candidate = closes[benchmarkCursor]!;
        benchmarkClose = validClose(candidate) ? candidate : null;
      }
    }
    let benchmarkIndex: number | null = null;
    let benchmarkValue: string | null = null;
    if (benchmarkClose !== null) {
      if (benchmarkBase === null) {
        benchmarkBase = benchmarkClose;
      }
      benchmarkIndex = benchmarkClose / benchmarkBase;
      if (benchmarkIndex > benchmarkPeak) {
        benchmarkPeak = benchmarkIndex;
      } else {
        benchmarkMaxDrawdown = Math.max(
          benchmarkMaxDrawdown,
          (1 - benchmarkIndex / benchmarkPeak) * 100,
        );
      }
      const markPrice = price(benchmarkClose);
      if (benchmarkPending.gt(0) && markPrice.gt(0)) {
        benchmarkShares = benchmarkShares.plus(benchmarkPending.div(markPrice));
        benchmarkPending = ZERO;
      }
      benchmarkValue = moneyText(money(benchmarkShares.times(markPrice)));
    }

    equity.push({
      date,
      cash: moneyText(cash),
      positionsValue: moneyText(holdings),
      totalValue: moneyText(totalExact),
      investedCapital: moneyText(invested),
      returnIndex,
      benchmarkIndex,
      benchmarkValue,
      cashBaselineValue: moneyText(cashBaseline),
      openPositions: positions.size,
    });
  }

  const last = equity[equity.length - 1]!;
  const firstDate = calendar[0]!;
  const lastDate = calendar[calendar.length - 1]!;
  const portfolioReturnPercent = (last.returnIndex - 1) * 100;
  const benchmarkReturnPercent =
    last.benchmarkIndex === null ? null : (last.benchmarkIndex - 1) * 100;
  let unrealized = ZERO;
  for (const position of positions.values()) {
    unrealized = money(
      unrealized.plus(
        money(
          money(position.shares.times(price(position.lastPrice))).minus(
            position.costTotal,
          ),
        ),
      ),
    );
  }

  return {
    calendar,
    trades,
    equity,
    evidence,
    contributionDates,
    decisionsEvaluated,
    summary: {
      firstSimulatedDate: firstDate,
      lastSimulatedDate: lastDate,
      tradingDays: calendar.length,
      investedCapital: moneyText(invested),
      finalCash: last.cash,
      finalPositionsValue: last.positionsValue,
      finalValue: last.totalValue,
      netProfit: moneyText(money(money(last.totalValue).minus(invested))),
      portfolioReturnPercent,
      benchmarkReturnPercent,
      alphaPercent:
        benchmarkReturnPercent === null
          ? null
          : portfolioReturnPercent - benchmarkReturnPercent,
      portfolioCagrPercent: compoundAnnualGrowth(
        last.returnIndex,
        firstDate,
        lastDate,
      ),
      maxDrawdownPercent: maxDrawdown,
      benchmarkMaxDrawdownPercent:
        input.benchmark === null ? null : benchmarkMaxDrawdown,
      realizedPnl: moneyText(realized),
      unrealizedPnl: moneyText(unrealized),
      totalTrades: trades.length,
      buyTrades: trades.filter((trade) => trade.action === "BUY").length,
      sellTrades: trades.filter((trade) => trade.action === "SELL").length,
      finalExitTrades: trades.filter((trade) => trade.action === "FINAL_EXIT")
        .length,
      winningTrades: trades.filter(
        (trade) => trade.realizedPnl !== null && dec(trade.realizedPnl).gt(0),
      ).length,
      losingTrades: trades.filter(
        (trade) => trade.realizedPnl !== null && dec(trade.realizedPnl).lt(0),
      ).length,
      openPositions: positions.size,
    },
  };
}

/**
 * CAGR of the time-weighted index over the simulated calendar span, in 365.25-day years
 * (`ai/architecture/backtest-execution.md`: "CAGR ... built on these" growth indices).
 */
export function compoundAnnualGrowth(
  finalIndex: number,
  firstDate: string,
  lastDate: string,
): number | null {
  const days =
    (Date.UTC(
      +lastDate.slice(0, 4),
      +lastDate.slice(5, 7) - 1,
      +lastDate.slice(8, 10),
    ) -
      Date.UTC(
        +firstDate.slice(0, 4),
        +firstDate.slice(5, 7) - 1,
        +firstDate.slice(8, 10),
      )) /
    86_400_000;
  if (!(days > 0) || !(finalIndex > 0)) {
    return null;
  }
  const years = days / 365.25;
  return (Math.pow(finalIndex, 1 / years) - 1) * 100;
}

/**
 * One figure per calendar year, that year alone: the index at the year's last simulated date over
 * the index at the previous year's last simulated date (1.0 before the first), minus one.
 * Partial when the requested period starts after 1 January or ends before 31 December of it.
 */
export function referenceAnnualReturns(
  points: readonly { date: string; returnIndex: number }[],
  period: { startDate: string; endDate: string },
): {
  year: string;
  simulatedThrough: string;
  returnPercent: number;
  partial: boolean;
}[] {
  const lastByYear = new Map<string, { date: string; returnIndex: number }>();
  for (const point of points) {
    if (!(point.returnIndex > 0)) {
      continue;
    }
    lastByYear.set(point.date.slice(0, 4), point);
  }
  const years = [...lastByYear.keys()].sort();
  let previous = 1;
  return years.map((year) => {
    const point = lastByYear.get(year)!;
    const returnPercent = (point.returnIndex / previous - 1) * 100;
    previous = point.returnIndex;
    return {
      year,
      simulatedThrough: point.date,
      returnPercent,
      partial:
        (year === period.startDate.slice(0, 4) &&
          period.startDate.slice(5) !== "01-01") ||
        (year === period.endDate.slice(0, 4) &&
          period.endDate.slice(5) !== "12-31"),
    };
  });
}
