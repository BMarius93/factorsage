import type { StructuredLogger } from "@intrinsic/observability";
import {
  PriceBasisChangedError,
  StockDataNotFoundError,
  type StockDetailsDataService,
} from "@intrinsic/stock-data";
import { describe, expect, it, vi } from "vitest";
import { LoggedStockDataService } from "./logged-stock-data.service";

const RANGE = { from: "2026-01-02", to: "2026-08-28" };

function recordingLogger() {
  const logger = {
    child: vi.fn(),
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function failingWith(failure: Error) {
  const delegate = {
    getDailyFundamentalMetric: vi.fn().mockRejectedValue(failure),
    getDailyValuationRatio: vi.fn().mockRejectedValue(failure),
  } as unknown as StockDetailsDataService;
  const logger = recordingLogger();
  return {
    logger,
    service: new LoggedStockDataService(
      delegate,
      logger as unknown as StructuredLogger,
    ),
  };
}

describe("LoggedStockDataService Fundamental Metric reads", () => {
  it("names the metric whose history failed, and rethrows the failure untouched", async () => {
    const failure = new Error("derived state unavailable");
    const { service, logger } = failingWith(failure);

    await expect(
      service.getDailyFundamentalMetric(" aapl ", "ROIC_TTM", RANGE),
    ).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "stock.data.operation.failed",
        operation: "getDailyFundamentalMetric",
        symbol: "AAPL",
        metricId: "ROIC_TTM",
        err: failure,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs an unknown symbol as a warning, still naming the metric", async () => {
    const failure = new StockDataNotFoundError("NOPE");
    const { service, logger } = failingWith(failure);

    await expect(
      service.getDailyFundamentalMetric("NOPE", "DEBT_TO_EQUITY", RANGE),
    ).rejects.toBe(failure);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getDailyFundamentalMetric",
        symbol: "NOPE",
        metricId: "DEBT_TO_EQUITY",
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("LoggedStockDataService valuation ratio reads", () => {
  it("names the ratio whose history failed, and rethrows the failure untouched", async () => {
    const failure = new Error("statements unavailable");
    const { service, logger } = failingWith(failure);

    await expect(
      service.getDailyValuationRatio(" msft ", "EV_TO_EBITDA_TTM", RANGE),
    ).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "stock.data.operation.failed",
        operation: "getDailyValuationRatio",
        symbol: "MSFT",
        ratioId: "EV_TO_EBITDA_TTM",
        err: failure,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a re-base committed during the read as a warning, never as a fault", async () => {
    const failure = new PriceBasisChangedError("security-1", "MSFT", 0, 1);
    const { service, logger } = failingWith(failure);

    await expect(
      service.getDailyValuationRatio("MSFT", "PRICE_TO_EARNINGS_TTM", RANGE),
    ).rejects.toBe(failure);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getDailyValuationRatio",
        ratioId: "PRICE_TO_EARNINGS_TTM",
        err: failure,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
