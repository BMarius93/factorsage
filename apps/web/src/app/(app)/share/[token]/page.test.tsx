import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSharedBacktestReport } from "../../../../features/backtests/sharing/shared-backtest-loader";
import {
  TEST_SHARE_TOKEN,
  TEST_SHARE_URL,
  testSharedReport,
} from "../../../../features/backtests/sharing/shared-backtest.test-helper";
import SharedBacktestPage, { dynamic, generateMetadata } from "./page";

vi.mock(
  "../../../../features/backtests/sharing/shared-backtest-loader",
  () => ({ loadSharedBacktestReport: vi.fn() }),
);

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const loadMock = vi.mocked(loadSharedBacktestReport);
const params = Promise.resolve({ token: TEST_SHARE_TOKEN });

beforeEach(() => {
  loadMock.mockReset();
});

describe("/share/[token]", () => {
  it("is read on every request, so a revoked link stops rendering at once", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("answers a crawler with the report's own Open Graph metadata", async () => {
    loadMock.mockResolvedValue(testSharedReport());
    const metadata = await generateMetadata({ params });
    expect(metadata.openGraph?.url).toBe(TEST_SHARE_URL);
    expect(metadata.title).toEqual({
      absolute: "6.3% Annualized vs 3.9% Total Market Index | FactorSage",
    });
    expect(loadMock).toHaveBeenCalledWith(TEST_SHARE_TOKEN);
  });

  it("describes an unknown or revoked link without naming any backtest", async () => {
    loadMock.mockResolvedValue(null);
    const metadata = await generateMetadata({ params });
    expect(metadata.title).toEqual({
      absolute: "Shared backtest unavailable | FactorSage",
    });
    expect(metadata.openGraph).toBeUndefined();
  });

  it("renders the report for a live link", async () => {
    loadMock.mockResolvedValue(testSharedReport());
    const element = await SharedBacktestPage({ params });
    expect(element.props.report.runId).toBe(testSharedReport().runId);
  });

  it("is a not-found for an unknown or revoked link", async () => {
    loadMock.mockResolvedValue(null);
    await expect(SharedBacktestPage({ params })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
