import {
  PLAN_ENTITLEMENTS,
  type BenchmarkResponse,
  type StockListSummaryResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createBacktestRun, fetchBenchmarks } from "../api/backtests-api";
import { NewBacktestForm } from "./NewBacktestForm";

/**
 * Premium built-in content in the New Backtest form (`docs/decisions/entitlements-v2.md` §6).
 *
 * Every plan name the form says comes from the entitlement matrix, never from its own copy. This
 * suite proves it by moving the matrix: here **only Pro+** includes premium content, so a form that
 * had written "Pro" down would be caught saying it. Today's matrix (Pro and Pro+) is covered by
 * `NewBacktestForm.universe.test.tsx`.
 */
vi.mock("@intrinsic/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intrinsic/contracts")>();
  return {
    ...actual,
    PLAN_ENTITLEMENTS: {
      ...actual.PLAN_ENTITLEMENTS,
      PRO: {
        ...actual.PLAN_ENTITLEMENTS.PRO,
        builtInContent: {
          ...actual.PLAN_ENTITLEMENTS.PRO.builtInContent,
          canUsePremium: false,
        },
      },
    },
  };
});

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
    plan: "STARTER",
    role: "USER",
    entitlements: PLAN_ENTITLEMENTS.STARTER,
  }),
}));

const OWN_STRATEGY: StrategySummaryResponse = {
  ownership: "USER",
  canEdit: true,
  id: "own-strategy",
  name: "Trend",
  buyLevelCount: 1,
  sellLevelCount: 0,
  hasFinalExit: true,
  versionNumber: 1,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

/** A premium built-in strategy, as the API sends it to a plan without premium content. */
const LOCKED_STRATEGY: StrategySummaryResponse = {
  ...OWN_STRATEGY,
  ownership: "SYSTEM",
  systemKey: "premium-momentum",
  canEdit: false,
  premium: true,
  locked: true,
  id: "locked-strategy",
  name: "Premium Momentum",
};

const OWN_LIST: StockListSummaryResponse = {
  ownership: "USER",
  canEdit: true,
  id: "own-list",
  name: "Quality compounders",
  itemCount: 8,
  compliance: { symbolCount: 8, symbolLimit: 50, compliant: true },
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
};

/** A premium built-in list that is not a point-in-time universe. */
const LOCKED_LIST: StockListSummaryResponse = {
  ...OWN_LIST,
  ownership: "SYSTEM",
  systemKey: "premium-leaders",
  canEdit: false,
  premium: true,
  locked: true,
  id: "locked-list",
  name: "Premium Leaders",
  itemCount: 40,
  compliance: { symbolCount: 40, symbolLimit: null, compliant: true },
};

const BENCHMARKS: BenchmarkResponse[] = [
  { id: "b-1", code: "SP500", name: "S&P 500", currency: "USD" },
];

/** Rendered text with whitespace collapsed, as a reader sees it. */
const text = (element: HTMLElement) =>
  (element.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  vi.mocked(fetchStrategies)
    .mockReset()
    .mockResolvedValue([OWN_STRATEGY, LOCKED_STRATEGY]);
  vi.mocked(fetchStockLists)
    .mockReset()
    .mockResolvedValue([OWN_LIST, LOCKED_LIST]);
  vi.mocked(fetchBenchmarks).mockReset().mockResolvedValue(BENCHMARKS);
  vi.mocked(createBacktestRun).mockReset();
});

describe("NewBacktestForm with premium built-ins", () => {
  it("marks a locked strategy with the plans the matrix includes it in, and says so beside the field", async () => {
    const user = userEvent.setup();
    render(<NewBacktestForm />);
    const strategy = (await screen.findByLabelText(
      "Strategy",
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Premium Momentum · Pro+" }),
      ).toBeTruthy(),
    );
    // What the plan does include stays unmarked.
    expect(screen.getByRole("option", { name: "Trend" })).toBeTruthy();

    await user.selectOptions(strategy, "locked-strategy");
    const hint = await screen.findByTestId("backtest-strategy-locked");
    expect(text(hint)).toBe(
      "Premium strategies are part of the Pro+ plan. See plans",
    );
    expect(
      screen.getByTestId("backtest-strategy-see-plans").getAttribute("href"),
    ).toBe("/billing");
    expect(strategy.getAttribute("aria-describedby")).toBe(
      "backtest-strategy-hint",
    );
  });

  it("refuses a locked strategy before anything is submitted, and focuses it", async () => {
    const user = userEvent.setup();
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");
    await user.selectOptions(
      screen.getByLabelText("Strategy"),
      "locked-strategy",
    );
    await user.selectOptions(screen.getByLabelText("Stock list"), "own-list");
    await user.click(screen.getByTestId("submit-backtest"));

    expect(vi.mocked(createBacktestRun)).not.toHaveBeenCalled();
    const strategy = screen.getByLabelText("Strategy");
    expect(document.activeElement).toBe(strategy);
    expect(strategy.getAttribute("aria-invalid")).toBe("true");
    expect(strategy.getAttribute("aria-describedby")).toBe(
      "backtest-strategy-error",
    );
    expect(text(document.getElementById("backtest-strategy-error")!)).toBe(
      "Premium strategies are part of the Pro+ plan. See plans",
    );
  });

  it("refuses a locked premium list before anything is submitted, with the way to the plans", async () => {
    const user = userEvent.setup();
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");
    expect(
      screen.getByRole("option", { name: "Premium Leaders · Pro+" }),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Strategy"), "own-strategy");
    await user.selectOptions(
      screen.getByLabelText("Stock list"),
      "locked-list",
    );

    expect(text(await screen.findByTestId("backtest-list-locked"))).toBe(
      "Premium lists are part of the Pro+ plan. See plans",
    );
    // Not a size problem: the per-backtest stock limit is never what it is told.
    expect(screen.queryByTestId("backtest-list-over-limit")).toBeNull();

    await user.click(screen.getByTestId("submit-backtest"));
    expect(vi.mocked(createBacktestRun)).not.toHaveBeenCalled();
    const list = screen.getByLabelText("Stock list");
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-describedby")).toBe("backtest-list-error");
    expect(
      screen.getByTestId("backtest-list-see-plans").getAttribute("href"),
    ).toBe("/billing");
  });

  it("submits what the plan does include", async () => {
    const user = userEvent.setup();
    const { testDetail } = await import("../utils/backtest.test-helper");
    vi.mocked(createBacktestRun).mockResolvedValue(
      testDetail("QUEUED", { id: "run-9" }),
    );
    render(<NewBacktestForm />);
    await screen.findByLabelText("Benchmark");
    await user.selectOptions(screen.getByLabelText("Strategy"), "own-strategy");
    await user.selectOptions(screen.getByLabelText("Stock list"), "own-list");
    await user.click(screen.getByTestId("submit-backtest"));

    await waitFor(() =>
      expect(vi.mocked(createBacktestRun)).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByTestId("backtest-strategy-locked")).toBeNull();
    expect(screen.queryByTestId("backtest-list-locked")).toBeNull();
  });
});
