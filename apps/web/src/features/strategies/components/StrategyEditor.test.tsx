import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { entitlementRefusal } from "../../../lib/api/__testing__/request-failures";
import { signedInSession } from "../../auth/__testing__/auth-session";
import { fetchStrategy } from "../api/strategies-api";
import { StrategyEditor } from "./StrategyEditor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../api/strategies-api", () => ({
  fetchStrategy: vi.fn(),
}));

// The read-only view's backtest action asks the session who is looking; this suite reads as a
// signed-in customer. The Guest side is `StrategyReadOnlyView.test.tsx`.
vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: () => signedInSession(),
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
      screen.getByRole("link", { name: "Run backtest" }).getAttribute("href"),
    ).toBe("/backtests/new?strategyId=strategy-b");
  });

  it("explains a locked premium strategy instead of failing to load it (403)", async () => {
    fetchStrategyMock.mockRejectedValue(
      entitlementRefusal(
        "ENTITLEMENT_PREMIUM_CONTENT",
        "Your plan does not include premium predefined strategies",
      ),
    );
    render(<StrategyEditor strategyId="strategy-b" />);

    const locked = await screen.findByTestId("strategy-locked");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This strategy is premium content",
    );
    expect(locked.textContent).toContain(
      "Its rules are included in Pro and Pro+, where it can also be backtested and duplicated.",
    );
    expect(
      screen.getByRole("link", { name: "See plans" }).getAttribute("href"),
    ).toBe("/pricing");
    expect(
      screen
        .getByRole("link", { name: "Back to Strategies" })
        .getAttribute("href"),
    ).toBe("/strategies");
    // No rules, no backtest and no retry that could never work.
    expect(screen.queryByTestId("strategy-read-only")).toBeNull();
    expect(screen.queryByRole("link", { name: "Run backtest" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("still reports an ordinary failure as one", async () => {
    fetchStrategyMock.mockRejectedValue(new ApiError(500, "Internal error"));
    render(<StrategyEditor strategyId="strategy-b" />);
    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeDefined();
    expect(screen.queryByTestId("strategy-locked")).toBeNull();
  });

  it("badges a premium strategy the viewer's plan includes, and keeps its rules and backtest", async () => {
    fetchStrategyMock.mockResolvedValue(strategy({ premium: true }));
    render(<StrategyEditor strategyId="strategy-b" />);

    expect(await screen.findByTestId("strategy-read-only")).toBeDefined();
    const badge = screen.getByTestId("premium-badge");
    expect(badge.textContent).toBe("Premium");
    expect(badge.getAttribute("data-locked")).toBeNull();
    expect(screen.getByText("Price crosses above SMA 20D")).toBeDefined();
    expect(screen.getByRole("link", { name: "Run backtest" })).toBeDefined();
  });

  it("opens a built-in strategy in the ordinary Builder for an administrator", async () => {
    fetchStrategyMock.mockResolvedValue(strategy({ canEdit: true }));
    render(<StrategyEditor strategyId="strategy-b" />);
    expect(await screen.findByTestId("builder-probe")).toBeDefined();
  });
});
