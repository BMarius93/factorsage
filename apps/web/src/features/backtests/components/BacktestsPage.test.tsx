import type { BacktestRunSummaryResponse } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
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
});
