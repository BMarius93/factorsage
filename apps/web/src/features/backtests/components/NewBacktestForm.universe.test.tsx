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
import { fetchBenchmarks } from "../api/backtests-api";
import { NewBacktestForm } from "./NewBacktestForm";

/**
 * The built-in point-in-time index universe in the New Backtest form
 * (`docs/decisions/sp500-historical-pit-v1.md`): measured by the most members it holds at once,
 * against the plan's own universe allowance — never by its distinct stock count against the
 * per-list stock limit, which it would always exceed.
 */

let plan: UserPlan = "PRO";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../api/backtests-api", () => ({
  fetchBenchmarks: vi.fn(),
  createBacktestRun: vi.fn(),
  fetchBacktestRuns: vi.fn().mockResolvedValue([]),
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

const universeList = (peak: number): StockListSummaryResponse => ({
  ownership: "SYSTEM",
  systemKey: "sp500-historical-pit",
  canEdit: false,
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
  itemCount: 120,
  compliance: { symbolCount: 120, symbolLimit: 100, compliant: false },
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

  it("tells a plan without the universe that it is not included", async () => {
    plan = "STARTER";
    await choose(universeList(506));
    expect(
      text(await screen.findByTestId("backtest-universe-over-limit")),
    ).toContain("Your plan does not include point-in-time index universes.");
  });

  it("compares the most members at once with the plan's universe allowance", async () => {
    await choose(universeList(600));
    expect(
      text(await screen.findByTestId("backtest-universe-over-limit")),
    ).toContain(
      "This universe holds up to 600 members at once; your plan runs up to 550.",
    );
  });

  it("keeps the per-list stock limit for every other List", async () => {
    await choose(LARGE_USER_LIST);
    expect(
      text(await screen.findByTestId("backtest-list-over-limit")),
    ).toContain(
      "This list has 120 stocks; your plan runs up to 100 per backtest.",
    );
    expect(screen.queryByTestId("backtest-universe-summary")).toBeNull();
  });
});
