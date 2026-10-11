import type { DashboardRowResponse } from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { DashboardOverview } from "./DashboardOverview";

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);

function row(
  overrides: Partial<DashboardRowResponse> = {},
): DashboardRowResponse {
  return {
    id: `row-${Math.random()}`,
    state: "ACTIVE",
    security: {
      id: "sec-1",
      symbol: "QATEST1",
      name: "QA Test One",
      exchangeCode: "NASDAQ",
    },
    levelKind: "BUY",
    reasons: [],
    monitor: { id: "m-1", name: "Monitor", ownership: "SYSTEM" },
    strategy: { id: "s-1", name: "Strategy" },
    stockList: { id: "l-1", name: "List" },
    since: "2026-09-16T12:00:00.000Z",
    reconstructed: false,
    ...overrides,
  };
}

function signedIn(value: boolean) {
  useAuthSessionMock.mockReturnValue({
    state: value
      ? {
          status: "authenticated",
          user: {
            id: "user-1",
            email: "pro@example.test",
            role: "USER",
            plan: "PRO",
          },
        }
      : { status: "unauthenticated" },
    refresh: vi.fn(),
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuthSession>);
}

async function renderOverview(
  rows: DashboardRowResponse[] = [],
  rowsReady = true,
) {
  render(<DashboardOverview rows={rows} rowsReady={rowsReady} />);
  await screen.findByTestId("dashboard-run-backtest");
}

/**
 * The Dashboard's opening strip.
 *
 * The count and the order are asserted literally, because they are the product decision: two cards,
 * `Run Backtest · Current matches`. The market lives in the market overview below, and a market card
 * creeping back into this strip is exactly the failure these tests exist to catch.
 */
describe("DashboardOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn(true);
  });

  it("renders exactly two cards, in the agreed order", async () => {
    await renderOverview();

    const cards = [
      screen.getByTestId("dashboard-run-backtest"),
      screen.getByTestId("dashboard-matches-card"),
    ];
    const grid = cards[0]?.parentElement as HTMLElement;
    expect([...grid.children]).toEqual(cards);
    expect([...grid.children].map((card) => card.textContent)).toEqual([
      expect.stringContaining("Run Backtest"),
      expect.stringContaining("Current matches"),
    ]);
  });

  it("carries no market card: the market overview below replaced them", async () => {
    await renderOverview();

    const strip = screen.getByTestId("dashboard-overview");
    for (const forbidden of [/S&P 500/, /DJIA/, /VIX/, /nasdaq/i, /fear/i, /greed/i]) {
      expect(within(strip).queryByText(forbidden)).toBeNull();
    }
    expect(screen.queryByTestId(/^dashboard-market-card-/)).toBeNull();
  });

  it("links a signed-in viewer straight to the canonical New Backtest route", async () => {
    await renderOverview();

    const card = screen.getByTestId("dashboard-run-backtest");
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe("/backtests/new");
    expect(card.textContent).toContain("Run Backtest");
  });

  it("asks a Guest for an account in place, without navigating", async () => {
    // The Dashboard is already where sign-in lands by default, so its links carry no `next`.
    window.history.replaceState(null, "", "/dashboard");
    signedIn(false);
    await renderOverview();

    const card = screen.getByTestId("dashboard-run-backtest");
    // A button, not a link: the honest answer to the click is a question, not a destination.
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("href")).toBeNull();

    await userEvent.click(card);

    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt)
        .getByRole("link", { name: "Sign in" })
        .getAttribute("href"),
      // Signing in goes straight to New Backtest, the thing the Guest asked for (UI-042).
    ).toBe("/login?next=%2Fbacktests%2Fnew");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register?next=%2Fbacktests%2Fnew");
    // And the Dashboard is still underneath it: no redirect to /login for a click.
    expect(screen.queryByTestId("dashboard-overview")).not.toBeNull();
    expect(screen.getByTestId("dashboard-matches-card")).toBeTruthy();
  });

  it("counts every current row the viewer's dashboard returned", async () => {
    await renderOverview([
      row({ id: "a", state: "ACTIVE" }),
      row({ id: "b", state: "ACTIVE" }),
      row({ id: "c", state: "PENDING_TRIGGER" }),
      row({ id: "d", state: "PENDING_TRIGGER" }),
      row({ id: "e", state: "PENDING_TRIGGER" }),
    ]);

    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("5");
    expect(screen.getByTestId("dashboard-matches-breakdown").textContent).toBe(
      "2 active · 3 waiting",
    );
  });

  it("holds the count back until the dashboard has actually answered", async () => {
    await renderOverview([], false);

    // A premature 0 reads as "nothing is matching", which is a different statement from "not known
    // yet" and the one thing a count must never say by accident.
    expect(screen.queryByTestId("dashboard-matches-total")).toBeNull();
  });

  it("points at the signals section rather than navigating away", async () => {
    await renderOverview([row()]);

    expect(
      screen.getByTestId("dashboard-matches-card").getAttribute("href"),
    ).toBe("#signals");
  });
});
