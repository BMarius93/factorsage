import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestSession,
  resolvingSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { SIGN_IN_TO_BACKTEST } from "../../auth/utils/sign-in-prompts";
import { StrategyReadOnlyView } from "./StrategyReadOnlyView";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);

const STRATEGY_PATH = "/strategies/strategy-b?from=dashboard";

function builtInStrategy(): StrategyDetailResponse {
  return {
    ownership: "SYSTEM",
    systemKey: "trend-confirmation",
    canEdit: false,
    id: "strategy-b",
    name: "Trend Confirmation",
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
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
          },
        },
      ],
      sellLevels: [],
    },
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", STRATEGY_PATH);
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("StrategyReadOnlyView backtest action (UX-002)", () => {
  it("gives a signed-in viewer a real link with the strategy prefilled", () => {
    useAuthSessionMock.mockReturnValue(signedInSession());
    render(<StrategyReadOnlyView strategy={builtInStrategy()} />);

    const link = screen.getByRole("link", { name: "Backtest this strategy" });
    expect(link.getAttribute("href")).toBe(
      "/backtests/new?strategyId=strategy-b",
    );
  });

  it("asks a Guest to sign in, in place, instead of following the link", async () => {
    useAuthSessionMock.mockReturnValue(guestSession());
    render(<StrategyReadOnlyView strategy={builtInStrategy()} />);

    // A button, never a link a Guest would follow into a protected route.
    expect(
      screen.queryByRole("link", { name: "Backtest this strategy" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Backtest this strategy" }),
    );

    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(prompt.getAttribute("aria-label")).toBe(SIGN_IN_TO_BACKTEST.title);
    expect(prompt.textContent).toContain(SIGN_IN_TO_BACKTEST.body);
    // Both answers come back to exactly this page, query included (UX-003).
    expect(
      within(prompt)
        .getByRole("link", { name: "Sign in" })
        .getAttribute("href"),
    ).toBe(`/login?next=${encodeURIComponent(STRATEGY_PATH)}`);
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe(`/register?next=${encodeURIComponent(STRATEGY_PATH)}`);

    // Nothing navigated: the router was not touched and the address is unchanged.
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      STRATEGY_PATH,
    );
    expect(screen.getByTestId("strategy-read-only")).toBeDefined();
  });

  it("does nothing while the session is still resolving", async () => {
    useAuthSessionMock.mockReturnValue(resolvingSession());
    render(<StrategyReadOnlyView strategy={builtInStrategy()} />);

    const action = screen.getByRole("button", {
      name: "Backtest this strategy",
    });
    expect(action.hasAttribute("disabled")).toBe(true);
    await userEvent.click(action);

    expect(screen.queryByTestId("sign-in-prompt")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Backtest this strategy" }),
    ).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
