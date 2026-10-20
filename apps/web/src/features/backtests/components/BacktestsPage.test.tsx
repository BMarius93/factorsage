import type { BacktestRunSummaryResponse } from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBacktestRuns } from "../api/backtests-api";
import { BacktestsPage } from "./BacktestsPage";

vi.mock("../api/backtests-api", () => ({ fetchBacktestRuns: vi.fn() }));
const fetchMock = vi.mocked(fetchBacktestRuns);

function summary(
  status: BacktestRunSummaryResponse["status"],
  id: string,
): BacktestRunSummaryResponse {
  return {
    id,
    status,
    strategyId: "strategy-1",
    strategyName: `Strategy ${id}`,
    stockListId: "list-1",
    stockListName: "Quality compounders",
    benchmarkCode: "TMI",
    benchmarkName: "Total Market Index",
    startDate: "2021-01-04",
    endDate: "2026-01-02",
    initialCapital: 10_000,
    maximumPositions: 10,
    queuedAt: "2026-09-01T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    progressPercent: status === "COMPLETED" ? 100 : 40,
    progressMessage: null,
    portfolioReturnPercent: status === "COMPLETED" ? 12 : null,
    benchmarkReturnPercent: null,
    alphaPercent: null,
    portfolioCagrPercent: status === "COMPLETED" ? 2.3 : null,
  };
}

describe("BacktestsPage", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  /**
   * A collection row says one thing about a job that has not finished: it is alive.
   *
   * The assertion is on the semantic hook the badge publishes, never on an animation frame — a
   * test that sampled CSS keyframes would be brittle and would prove nothing about the product
   * rule, which is simply that a finished run stays still.
   */
  it("marks queued and running rows as live work, and leaves terminal ones still", async () => {
    fetchMock.mockResolvedValue([
      summary("QUEUED", "run-queued"),
      summary("RUNNING", "run-running"),
      summary("COMPLETED", "run-completed"),
      summary("FAILED", "run-failed"),
    ]);

    render(<BacktestsPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("backtest-card-status")).toHaveLength(4),
    );

    const badges = screen.getAllByTestId("backtest-card-status");
    expect(
      badges.map((badge) => [
        badge.getAttribute("data-status"),
        badge.getAttribute("data-activity"),
      ]),
    ).toEqual([
      ["QUEUED", "pulse"],
      ["RUNNING", "pulse"],
      ["COMPLETED", null],
      ["FAILED", null],
    ]);
    // The status label itself never changes: the dot is decorative and hidden from assistive tech.
    expect(badges[0]?.textContent).toBe("Queued");
    expect(badges[1]?.textContent).toBe("Running");
  });

  it("compares runs by CAGR, and keeps the benchmark out of the stock-list cell (BT-3)", async () => {
    // A long run with a large total return but a modest CAGR, and short runs that beat it per year.
    const runs = Array.from({ length: 10 }, (_, index) => ({
      ...summary("COMPLETED", `run-${index}`),
      portfolioReturnPercent: index === 0 ? 900 : 40 + index,
      portfolioCagrPercent: index === 0 ? 7.9 : 8 + index,
      benchmarkReturnPercent: 50,
      alphaPercent: index === 0 ? 850 : -10 + index,
    }));
    fetchMock.mockResolvedValue(runs);
    const user = userEvent.setup();

    render(<BacktestsPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("backtest-card-status")).toHaveLength(10),
    );

    // The CAGR column carries the stored annualized return; excess return is in points.
    const first = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(first).getByText("+7.90%")).toBeTruthy();
    expect(within(first).getByText("+850.00 pp")).toBeTruthy();

    const sort = screen.getByRole("combobox", { name: /sort/i });
    expect(
      within(sort).queryByRole("option", { name: "Best return" }),
    ).toBeNull();
    await user.selectOptions(sort, "Best CAGR");

    const names = screen
      .getAllByRole("link", { name: /^Strategy run-/ })
      .map((link) => link.textContent?.replace(/Jan.*$/, ""));
    // The 900% thirty-year-style run ranks by its 7.90% CAGR — last — not by its total.
    expect(names[0]).toBe("Strategy run-9");
    expect(names.at(-1)).toBe("Strategy run-0");

    // Folded between 880 and 1,279px, the benchmark joins the total return as a comparison —
    // never the stock-list cell.
    const folded = screen.getAllByTestId("backtest-folded-benchmark")[0]!;
    expect(folded.textContent).toBe("vs Total Market Index +50.00%");
    expect(folded.closest("td")?.getAttribute("data-column")).toBe("portfolio");
    // The stock list folds under the strategy in the same band, so the run's figures keep their
    // columns; it is still the list's link.
    const foldedList = screen.getAllByTestId("backtest-folded-list")[0]!;
    expect(foldedList.closest("td")?.getAttribute("data-column")).toBe("run");
    expect(
      within(foldedList)
        .getByRole("link", { name: /Quality compounders/ })
        .getAttribute("href"),
    ).toBe("/lists/list-1");
  });
});
