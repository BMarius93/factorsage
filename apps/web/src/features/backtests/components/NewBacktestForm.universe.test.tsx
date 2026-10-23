import {
  PLAN_ENTITLEMENTS,
  type BenchmarkResponse,
  type StockListSummaryResponse,
  type StrategySummaryResponse,
  type UserPlan,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createBacktestRun, fetchBenchmarks } from "../api/backtests-api";
import { NewBacktestForm } from "./NewBacktestForm";

/**
 * The built-in point-in-time index universe in the New Backtest form
 * (`docs/decisions/sp500-historical-pit-v1.md`): measured by the most members it holds at once,
 * against the plan's own universe allowance — never by its distinct stock count against the
 * per-list stock limit, which it would always exceed.
 */

let plan: UserPlan = "PRO";

/** Pro's own allowances, read from the matrix so the fixtures sit just past them whatever they are. */
const PRO_BACKTEST_SYMBOLS = PLAN_ENTITLEMENTS.PRO.backtests.maxSymbols ?? 0;
const PRO_UNIVERSE_MEMBERS =
  PLAN_ENTITLEMENTS.PRO.backtests.maxIndexUniverseConstituents ?? 0;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../api/backtests-api", () => ({
  fetchBenchmarks: vi.fn(),
  createBacktestRun: vi.fn(),
  fetchActiveBacktestRuns: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));
vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));
vi.mock("../../auth/hooks/use-entitlements", () => ({
  useEntitlements: () => ({
    status: "ready",
    plan,
    role: "USER",
    entitlements: PLAN_ENTITLEMENTS[plan],
  }),
}));

const STRATEGY: StrategySummaryResponse = {
  ownership: "USER",
  canEdit: true,
  id: "strategy-1",
  name: "Trend",
  buyLevelCount: 1,
  sellLevelCount: 0,
  hasFinalExit: true,
  versionNumber: 1,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

/**
 * The universe as the API sends it to the viewer's plan: premium content, and `locked` where the
 * plan does not include premium content.
 */
const universeList = (peak: number): StockListSummaryResponse => ({
  ownership: "SYSTEM",
  systemKey: "sp500-historical-pit",
  canEdit: false,
  premium: true,
  ...(PLAN_ENTITLEMENTS[plan].builtInContent.canUsePremium
    ? {}
    : { locked: true as const }),
  id: "sp500-pit",
  name: "S&P 500 — Historical PIT",
  itemCount: 731,
  compliance: { symbolCount: 731, symbolLimit: null, compliant: true },
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  universe: {
    kind: "POINT_IN_TIME_INDEX",
    indexKey: "SP500",
    distinctSecurities: 731,
    peakSimultaneousMembers: peak,
    currentMembers: 503,
    membershipFloor: "1996-01-02",
    syncedAt: "2026-10-17T10:00:00.000Z",
  },
});

const LARGE_USER_LIST: StockListSummaryResponse = {
  ownership: "USER",
  canEdit: true,
  id: "large",
  name: "Large list",
  itemCount: PRO_BACKTEST_SYMBOLS + 20,
  compliance: {
    symbolCount: PRO_BACKTEST_SYMBOLS + 20,
    symbolLimit: PRO_BACKTEST_SYMBOLS,
    compliant: false,
  },
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const BENCHMARKS: BenchmarkResponse[] = [
  { id: "b-1", code: "SP500", name: "S&P 500", currency: "USD" },
];

async function choose(list: StockListSummaryResponse) {
  vi.mocked(fetchStockLists).mockResolvedValue([list]);
  render(<NewBacktestForm />);
  const select = (await screen.findByLabelText(
    "Stock list",
  )) as HTMLSelectElement;
  await userEvent.selectOptions(select, list.id);
  await waitFor(() => expect(select.value).toBe(list.id));
}

/** Rendered text with whitespace collapsed, as a reader sees it. */
const text = (element: HTMLElement) =>
  (element.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  plan = "PRO";
  vi.mocked(fetchStrategies).mockReset().mockResolvedValue([STRATEGY]);
  vi.mocked(fetchBenchmarks).mockReset().mockResolvedValue(BENCHMARKS);
  vi.mocked(createBacktestRun).mockReset();
});

describe("NewBacktestForm with the point-in-time index universe", () => {
  it("lets Pro run the S&P 500 universe and says what its membership means", async () => {
    await choose(universeList(506));
    expect(
      text(await screen.findByTestId("backtest-universe-summary")),
    ).toContain("731 stocks over time, up to 506 at once");
    expect(screen.queryByTestId("backtest-universe-over-limit")).toBeNull();
    // Its 731 stocks are not held to the 100-stock per-list limit.
    expect(screen.queryByTestId("backtest-list-over-limit")).toBeNull();
  });

  it("tells a plan without the universe that it is not included, before anything is submitted (PR-1)", async () => {
    plan = "STARTER";
    await choose(universeList(506));
    // Marked in the picker with the plans that include it, so choosing it is never a surprise.
    expect(
      screen.getByRole("option", {
        name: "S&P 500 — Historical PIT · Pro and Pro+",
      }),
    ).toBeTruthy();
    expect(
      text(await screen.findByTestId("backtest-universe-over-limit")),
    ).toBe(
      "Backtests over the S&P 500 Historical PIT universe are part of the Pro and Pro+ plans. See plans",
    );
    expect(
      screen.getByTestId("backtest-universe-see-plans").getAttribute("href"),
    ).toBe("/billing");

    // Running it anyway sends nothing: the field says why, and focus goes to it.
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Strategy"), "strategy-1");
    await user.click(screen.getByTestId("submit-backtest"));
    expect(vi.mocked(createBacktestRun)).not.toHaveBeenCalled();
    const list = screen.getByLabelText("Stock list");
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-invalid")).toBe("true");
    expect(list.getAttribute("aria-describedby")).toBe("backtest-list-error");
    expect(text(document.getElementById("backtest-list-error")!)).toContain(
      "part of the Pro and Pro+ plans",
    );
  });

  it("marks nothing in the picker for a plan that includes the universe", async () => {
    await choose(universeList(506));
    expect(
      screen.getByRole("option", { name: "S&P 500 — Historical PIT" }),
    ).toBeTruthy();
  });

  it("never tells anyone to remove stocks from the read-only universe when the server refuses it (BT-4)", async () => {
    const { ApiError } = await import("../../../lib/api/client");
    vi.mocked(createBacktestRun).mockRejectedValue(
      new ApiError(
        403,
        "Your plan does not include backtests over the S&P 500 Historical PIT universe",
        "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
      ),
    );
    await choose(universeList(506));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Strategy"), "strategy-1");
    await user.click(screen.getByTestId("submit-backtest"));
    const error = await screen.findByTestId("backtest-submit-error");
    expect(text(error)).toContain("Choose a different list.");
    expect(text(error)).not.toContain("remove stocks");
  });

  it("compares the most members at once with the plan's universe allowance", async () => {
    await choose(universeList(PRO_UNIVERSE_MEMBERS + 50));
    expect(
      text(await screen.findByTestId("backtest-universe-over-limit")),
    ).toContain(
      `This universe holds up to ${PRO_UNIVERSE_MEMBERS + 50} members at once; your plan runs up to ${PRO_UNIVERSE_MEMBERS}.`,
    );
  });

  it("keeps the per-list stock limit for every other List", async () => {
    await choose(LARGE_USER_LIST);
    expect(
      text(await screen.findByTestId("backtest-list-over-limit")),
    ).toContain(
      `This list has ${PRO_BACKTEST_SYMBOLS + 20} stocks; your plan runs up to ${PRO_BACKTEST_SYMBOLS} per backtest.`,
    );
    expect(screen.queryByTestId("backtest-universe-summary")).toBeNull();
  });
});
