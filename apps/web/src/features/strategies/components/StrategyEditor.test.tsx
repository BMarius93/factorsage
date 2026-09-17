import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStrategy } from "../api/strategies-api";
import { StrategyEditor } from "./StrategyEditor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../api/strategies-api", () => ({
  fetchStrategy: vi.fn(),
}));

vi.mock("./StrategyBuilder", () => ({
  StrategyBuilder: ({ strategy }: { strategy: StrategyDetailResponse }) => (
    <div data-testid="builder-probe">{strategy.name}</div>
  ),
}));

const fetchStrategyMock = vi.mocked(fetchStrategy);

function strategy(
  overrides: Partial<StrategyDetailResponse>,
): StrategyDetailResponse {
  return {
    ownership: "SYSTEM",
    systemKey: "trend-confirmation",
    canEdit: false,
    id: "strategy-b",
    name: "Trend Confirmation",
    description: "Waits for short-term momentum to recover.",
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: true,
    versionNumber: 1,
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-17T09:00:00.000Z",
    definition: {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "buy",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
            trigger: {
              id: "t1",
              metric: { kind: "PRICE" },
              operator: "CROSSES_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_20D" },
            },
          },
        },
      ],
      sellLevels: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  fetchStrategyMock.mockReset();
});

describe("StrategyEditor", () => {
  it("shows a built-in strategy's logic read-only to a customer", async () => {
    fetchStrategyMock.mockResolvedValue(strategy({}));
    render(<StrategyEditor strategyId="strategy-b" />);

    expect(await screen.findByTestId("strategy-read-only")).toBeDefined();
    expect(screen.queryByTestId("builder-probe")).toBeNull();
    expect(screen.getByTestId("built-in-badge")).toBeDefined();
    expect(screen.getByText("Price crosses above SMA 20D")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Backtest this strategy" })
        .getAttribute("href"),
    ).toBe("/backtests/new?strategyId=strategy-b");
  });

  it("opens a built-in strategy in the ordinary Builder for an administrator", async () => {
    fetchStrategyMock.mockResolvedValue(strategy({ canEdit: true }));
    render(<StrategyEditor strategyId="strategy-b" />);
    expect(await screen.findByTestId("builder-probe")).toBeDefined();
  });
});
