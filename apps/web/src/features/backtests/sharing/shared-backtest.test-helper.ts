import type {
  SharedBacktestPreviewResponse,
  SharedBacktestReportResponse,
} from "@intrinsic/contracts";
import {
  TEST_BENCHMARK_NAME,
  TEST_PERIOD_END,
  TEST_PERIOD_START,
  testCurve,
  testResult,
} from "../utils/backtest.test-helper";

/** A 43-character base64url token, as the API issues them. */
export const TEST_SHARE_TOKEN = "Q2FyZWZ1bGx5LWNob3Nlbi1zeW50aGV0aWMtdG9rZW4";
export const TEST_SHARE_URL = `https://factorsage.example/share/${TEST_SHARE_TOKEN}`;

/** The public report of the same run the owner-page fixtures describe, as the API projects it. */
export function testSharedReport(
  overrides: Partial<SharedBacktestReportResponse> = {},
): SharedBacktestReportResponse {
  const { summary, annualReturns } = testResult();
  return {
    runNumber: 84,
    url: TEST_SHARE_URL,
    completedAt: "2026-01-03T09:30:00.000Z",
    configuration: {
      startDate: TEST_PERIOD_START,
      endDate: TEST_PERIOD_END,
      initialCapital: 10_000,
      monthlyContribution: 250,
      maximumPositions: 10,
      fullPositionPercent: 10,
      benchmark: { code: "TMI", name: TEST_BENCHMARK_NAME },
      securityCount: 750,
      strategyRuleCount: 12,
    },
    result: {
      summary: {
        firstSimulatedDate: summary.firstSimulatedDate,
        lastSimulatedDate: summary.lastSimulatedDate,
        finalValue: summary.finalValue,
        netProfit: summary.netProfit,
        portfolioReturnPercent: summary.portfolioReturnPercent,
        benchmarkReturnPercent: summary.benchmarkReturnPercent,
        alphaPercent: summary.alphaPercent,
        portfolioCagrPercent: summary.portfolioCagrPercent,
        benchmarkCagrPercent: summary.benchmarkCagrPercent,
        maxDrawdownPercent: summary.maxDrawdownPercent,
        benchmarkMaxDrawdownPercent: summary.benchmarkMaxDrawdownPercent,
        totalTrades: summary.totalTrades,
      },
      annualReturns,
      curve: testCurve(8),
    },
    ...overrides,
  };
}

export function testSharedPreview(
  overrides: Partial<SharedBacktestPreviewResponse> = {},
): SharedBacktestPreviewResponse {
  return {
    configuration: {
      startDate: TEST_PERIOD_START,
      endDate: TEST_PERIOD_END,
      benchmark: { code: "TMI", name: TEST_BENCHMARK_NAME },
      securityCount: 750,
      strategyRuleCount: 12,
    },
    headline: {
      portfolioCagrPercent: 18.44,
      benchmarkCagrPercent: 10.2,
      portfolioReturnPercent: 136,
      benchmarkReturnPercent: 62,
      maxDrawdownPercent: 31.27,
    },
    series: Array.from({ length: 240 }, (_unused, index) => ({
      date: new Date(Date.UTC(2021, 0, 4) + index * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      strategyValue: 10_000 * (1 + index / 120) * (index === 140 ? 0.7 : 1),
      benchmarkValue: index < 3 ? null : 10_000 * (1 + index / 200),
    })),
    ...overrides,
  };
}
