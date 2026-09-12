import type {
  BenchmarkResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createBacktestRun, fetchBenchmarks } from "../api/backtests-api";
import { testDetail } from "../utils/backtest.test-helper";
import { NewBacktestForm } from "./NewBacktestForm";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../api/backtests-api", () => ({
  fetchBenchmarks: vi.fn(),
  createBacktestRun: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const fetchStrategiesMock = vi.mocked(fetchStrategies);
const fetchStockListsMock = vi.mocked(fetchStockLists);
const fetchBenchmarksMock = vi.mocked(fetchBenchmarks);
const createBacktestRunMock = vi.mocked(createBacktestRun);

const STRATEGIES: StrategySummaryResponse[] = [
  {
    id: "strategy-1",
    name: "Deep value",
    buyLevelCount: 2,
    sellLevelCount: 1,
    hasFinalExit: true,
    versionNumber: 3,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];

const LISTS: StockListSummaryResponse[] = [
  {
    id: "list-1",
    name: "Quality compounders",
    itemCount: 12,
    compliance: { symbolCount: 12, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];

/**
 * The catalog is deliberately ordered with the default second: a form that simply preselects the
 * first option would pass a one-entry fixture and still be wrong.
 */
const BENCHMARKS: BenchmarkResponse[] = [
  { id: "b-2", code: "TMI", name: "Total Market Index", currency: "USD" },
  { id: "b-1", code: "SP500", name: "S&P 500", currency: "USD" },
];

beforeEach(() => {
  push.mockReset();
  fetchStrategiesMock.mockReset().mockResolvedValue(STRATEGIES);
  fetchStockListsMock.mockReset().mockResolvedValue(LISTS);
  fetchBenchmarksMock.mockReset().mockResolvedValue(BENCHMARKS);
  createBacktestRunMock.mockReset();
});

describe("NewBacktestForm", () => {
  it("offers the catalog's benchmarks and preselects the canonical default", async () => {
    render(<NewBacktestForm />);

    const benchmark = await screen.findByLabelText("Benchmark");
    await waitFor(() =>
      expect((benchmark as HTMLSelectElement).value).toBe("SP500"),
    );
    expect(
      screen.getByRole("option", { name: "Total Market Index" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "S&P 500" })).toBeTruthy();
  });

  it("derives the full position size from maximum positions", async () => {
    const user = userEvent.setup();
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");

    expect(screen.getByTestId("full-position-help").textContent).toBe(
      "10 positions → a full position is 10% of the portfolio; a 25% BUY level targets 2.5%",
    );

    const positions = screen.getByTestId("backtest-max-positions");
    await user.clear(positions);
    await user.type(positions, "4");

    expect(screen.getByTestId("full-position-help").textContent).toBe(
      "4 positions → a full position is 25% of the portfolio; a 25% BUY level targets 6.25%",
    );
  });

  it("rejects an incomplete submission before it reaches the API", async () => {
    const user = userEvent.setup();
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");

    await user.click(screen.getByTestId("submit-backtest"));

    expect(
      screen.getByText("Choose the strategy this backtest should run."),
    ).toBeTruthy();
    expect(
      screen.getByText("Choose the stock list this backtest should trade."),
    ).toBeTruthy();
    expect(createBacktestRunMock).not.toHaveBeenCalled();
  });

  it("submits the run and opens its page", async () => {
    const user = userEvent.setup();
    createBacktestRunMock.mockResolvedValue(
      testDetail("QUEUED", { id: "run-77" }),
    );
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");

    await user.selectOptions(screen.getByLabelText("Strategy"), "strategy-1");
    await user.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    await user.clear(screen.getByTestId("backtest-capital"));
    await user.type(screen.getByTestId("backtest-capital"), "25000");
    await user.type(screen.getByTestId("backtest-contribution"), "250");
    await user.click(screen.getByTestId("submit-backtest"));

    await waitFor(() => expect(createBacktestRunMock).toHaveBeenCalledTimes(1));
    expect(createBacktestRunMock.mock.calls[0]?.[0]).toMatchObject({
      strategyId: "strategy-1",
      stockListId: "list-1",
      benchmarkCode: "SP500",
      initialCapital: 25_000,
      monthlyContribution: 250,
      maximumPositions: 10,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/backtests/run-77"));
  });

  it("renders the API's own rejection message inline", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("../../../lib/api/client");
    createBacktestRunMock.mockRejectedValue(
      new ApiError(
        400,
        "A backtest cannot start before the stock list has any buy window.",
        "BACKTEST_INVALID",
      ),
    );
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");

    await user.selectOptions(screen.getByLabelText("Strategy"), "strategy-1");
    await user.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    await user.click(screen.getByTestId("submit-backtest"));

    expect(
      (await screen.findByTestId("backtest-submit-error")).textContent,
    ).toBe("A backtest cannot start before the stock list has any buy window.");
    expect(push).not.toHaveBeenCalled();
  });
});
