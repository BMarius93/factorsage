import type {
  BacktestCurvePointResponse,
  BacktestLiveSnapshotResponse,
  BacktestProgressResponse,
  BacktestResultResponse,
  BacktestRunConfigurationResponse,
  BacktestMilestoneResponse,
  BacktestRunDetailResponse,
  BacktestRunStatus,
} from "@intrinsic/contracts";

/**
 * Fixtures for the backtest web tests.
 *
 * The benchmark is deliberately **not** the S&P 500: every label the pages render must come from
 * the run's own snapshot, and a fixture that happened to match a hard-coded default would hide
 * exactly the bug worth catching.
 */
export const TEST_BENCHMARK_NAME = "Total Market Index";

export function testConfiguration(
  overrides: Partial<BacktestRunConfigurationResponse> = {},
): BacktestRunConfigurationResponse {
  return {
    strategyId: "strategy-1",
    strategyName: "Deep value",
    strategyVersionNumber: 3,
    stockListId: "list-1",
    stockListName: "Quality compounders",
    securityCount: 12,
    startDate: "2021-01-04",
    endDate: "2026-01-02",
    initialCapital: 10_000,
    monthlyContribution: 250,
    maximumPositions: 10,
    fullPositionPercent: 10,
    benchmark: {
      benchmarkId: "benchmark-1",
      code: "TMI",
      name: TEST_BENCHMARK_NAME,
      sourceKind: "FMP_SYMBOL",
      methodologyVersion: 1,
    },
    methodology: {
      calendar: "calendar@1",
      executionCalendar: "execution-calendar@1",
      candidateOrdering: "candidate-ordering@1",
      execution: "execution@1",
      executionCosts: "execution-costs@1",
      cashYield: "cash-yield@1",
      comparisonScenarios: "comparison-scenarios@1",
      strategyEvaluation: "signal-evaluation@1",
      contribution: "contribution@1",
      returns: "returns@1",
      costBasis: "cost-basis@1",
    },
    ...overrides,
  };
}

export function testCurve(length: number): BacktestCurvePointResponse[] {
  return Array.from({ length }, (_unused, index) => ({
    date: `2021-01-${String(index + 4).padStart(2, "0")}`,
    portfolioReturnPercent: index * 0.5,
    // Every other point is a genuine gap, so a fabricated zero would be visible in the counts.
    benchmarkReturnPercent: index % 2 === 0 ? index * 0.4 : null,
    strategyValue: 100_000 + index * 500,
    benchmarkValue: index % 2 === 0 ? 100_000 + index * 400 : null,
    cashBaselineValue: 100_000,
  }));
}

/** A curve as a run completed before the funded benchmark scenario existed would report it. */
export function testCurveWithoutBenchmarkValues(
  length: number,
): BacktestCurvePointResponse[] {
  return testCurve(length).map((point) => ({
    ...point,
    benchmarkValue: null,
  }));
}

export function testLive(
  overrides: Partial<BacktestLiveSnapshotResponse> = {},
): BacktestLiveSnapshotResponse {
  return {
    simulatedThrough: "2023-06-30",
    completedDays: 620,
    totalDays: 1_250,
    cash: 2_400,
    positionsValue: 11_600,
    totalValue: 14_000,
    investedCapital: 12_500,
    netProfit: 1_500,
    portfolioReturnPercent: 12,
    benchmarkReturnPercent: 8,
    alphaPercent: 4,
    maxDrawdownPercent: 9.5,
    benchmarkValue: 13_400,
    cashBaselineValue: 12_500,
    tradeCount: 18,
    openPositions: 4,
    curve: testCurve(4),
    holdings: [],
    recentTrades: [],
    ...overrides,
  };
}

export function testResult(
  overrides: Partial<BacktestResultResponse> = {},
): BacktestResultResponse {
  return {
    summary: {
      firstSimulatedDate: "2021-01-04",
      lastSimulatedDate: "2026-01-02",
      tradingDays: 1_250,
      investedCapital: 25_000,
      finalCash: 1_200,
      finalPositionsValue: 32_800,
      finalValue: 34_000,
      netProfit: 9_000,
      portfolioReturnPercent: 36,
      benchmarkReturnPercent: 21,
      alphaPercent: 15,
      portfolioCagrPercent: 6.3,
      maxDrawdownPercent: 14.2,
      benchmarkMaxDrawdownPercent: 18.4,
      realizedPnl: 6_000,
      unrealizedPnl: 3_000,
      totalTrades: 42,
      buyTrades: 24,
      sellTrades: 16,
      finalExitTrades: 2,
      winningTrades: 28,
      losingTrades: 14,
      openPositions: 5,
    },
    curve: testCurve(8),
    trades: [
      {
        sequence: 1,
        date: "2021-02-01",
        symbol: "QATEST1",
        name: "QA Test One",
        action: "BUY",
        levelPercentage: 50,
        shares: 10,
        price: 100,
        amount: 1_000,
        realizedPnl: null,
        realizedPnlPercent: null,
      },
    ],
    holdings: [
      {
        symbol: "QATEST1",
        name: "QA Test One",
        shares: 10,
        averageCost: 100,
        lastPrice: 130,
        lastPriceDate: "2024-12-31",
        marketValue: 1_300,
        unrealizedPnlPercent: 30,
        allocationPercent: 12.5,
      },
    ],
    ...overrides,
  };
}

export function testMilestones(
  years: readonly string[],
): BacktestMilestoneResponse[] {
  return years.map((year, index) => ({
    sequence: index + 1,
    year,
    simulatedThrough: `${year}-12-31`,
    percent: Math.round(((index + 1) / years.length) * 100),
    completedDays: (index + 1) * 252,
    totalDays: years.length * 252,
    cash: 1_000,
    totalValue: 10_000 + index * 1_000,
    investedCapital: 10_000,
    portfolioReturnPercent: index * 5,
    benchmarkReturnPercent: index * 4,
    alphaPercent: index,
    maxDrawdownPercent: 6,
    tradeCount: index * 3,
    openPositions: 2,
  }));
}

export function testDetail(
  status: BacktestRunStatus,
  overrides: Partial<BacktestRunDetailResponse> = {},
): BacktestRunDetailResponse {
  return {
    id: "run-1",
    status,
    configuration: testConfiguration(),
    queuedAt: "2026-09-01T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    progress: {
      percent: 0,
      message: null,
      simulatedThrough: null,
      sequence: 0,
      updatedAt: null,
    },
    live: null,
    milestones: [],
    result: null,
    failure: null,
    ...overrides,
  };
}

export function testProgress(
  status: BacktestRunStatus,
  sequence: number,
  overrides: Partial<BacktestProgressResponse> = {},
): BacktestProgressResponse {
  return {
    runId: "run-1",
    status,
    percent: 0,
    message: null,
    milestones: [],
    simulatedThrough: null,
    sequence,
    updatedAt: "2026-09-01T10:00:05.000Z",
    startedAt: "2026-09-01T10:00:01.000Z",
    completedAt: null,
    live: null,
    failure: null,
    ...overrides,
  };
}
