import type {
  BacktestCurvePointResponse,
  BacktestHoldingResponse,
  BacktestLiveSnapshotResponse,
  BacktestTradeResponse,
} from "@intrinsic/contracts";
import type {
  BacktestCheckpoint,
  BacktestCheckpointHolding,
  BacktestCurvePoint,
  BacktestTradeRecord,
} from "@intrinsic/strategy";

/**
 * Projects an engine checkpoint into the payload the running page polls.
 *
 * The engine already downsampled the curve and trimmed the trade tail, so this only drops what the
 * browser has no use for: internal security ids, the level id behind a fill, and the cash/share
 * bookkeeping that belongs to the durable trade log rather than to a live tile.
 */
export function toLiveSnapshotResponse(
  checkpoint: BacktestCheckpoint,
): BacktestLiveSnapshotResponse {
  return {
    simulatedThrough: checkpoint.simulatedThrough,
    completedDays: checkpoint.completedDays,
    totalDays: checkpoint.totalDays,
    cash: checkpoint.cash,
    positionsValue: checkpoint.positionsValue,
    totalValue: checkpoint.totalValue,
    investedCapital: checkpoint.investedCapital,
    netProfit: checkpoint.netProfit,
    portfolioReturnPercent: checkpoint.portfolioReturnPercent,
    benchmarkReturnPercent: checkpoint.benchmarkReturnPercent,
    alphaPercent: checkpoint.alphaPercent,
    maxDrawdownPercent: checkpoint.maxDrawdownPercent,
    benchmarkValue: checkpoint.benchmarkValue,
    cashBaselineValue: checkpoint.cashBaselineValue,
    tradeCount: checkpoint.tradeCount,
    openPositions: checkpoint.openPositions,
    curve: checkpoint.curve.map(toCurvePoint),
    holdings: checkpoint.holdings.map(toHolding),
    recentTrades: checkpoint.recentTrades.map(toTrade),
  };
}

function toCurvePoint(point: BacktestCurvePoint): BacktestCurvePointResponse {
  return {
    date: point.date,
    portfolioReturnPercent: point.portfolioReturnPercent,
    benchmarkReturnPercent: point.benchmarkReturnPercent,
    strategyValue: point.strategyValue,
    benchmarkValue: point.benchmarkValue,
    cashBaselineValue: point.cashBaselineValue,
  };
}

function toHolding(
  holding: BacktestCheckpointHolding,
): BacktestHoldingResponse {
  return {
    symbol: holding.symbol,
    name: holding.name,
    shares: holding.shares,
    averageCost: holding.averageCost,
    lastPrice: holding.lastPrice,
    lastPriceDate: holding.lastPriceDate,
    marketValue: holding.marketValue,
    unrealizedPnlPercent: holding.unrealizedPnlPercent,
    allocationPercent: holding.allocationPercent,
  };
}

function toTrade(trade: BacktestTradeRecord): BacktestTradeResponse {
  return {
    sequence: trade.sequence,
    date: trade.date,
    symbol: trade.symbol,
    name: trade.name,
    action: trade.action,
    levelPercentage: trade.levelPercentage,
    shares: trade.shares,
    price: trade.price,
    amount: trade.amount,
    realizedPnl: trade.realizedPnl,
    realizedPnlPercent: trade.realizedPnlPercent,
  };
}
