import type {
  BacktestRunPageResponse,
  BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBacktestRunPage } from "../api/backtests-api";
import { viewOf } from "../hooks/use-backtest-run-page";
import { BACKTEST_COLLECTION_POLL_INTERVAL_MS } from "../hooks/use-backtest-runs";
import { BacktestsPage } from "./BacktestsPage";

vi.mock("../api/backtests-api", () => ({ fetchBacktestRunPage: vi.fn() }));
const fetchMock = vi.mocked(fetchBacktestRunPage);

const pushMock = vi.fn();
const replaceMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/backtests",
  useSearchParams: () => searchParams,
}));

function summary(
  status: BacktestRunSummaryResponse["status"],
  id: string,
  runNumber = 1,
): BacktestRunSummaryResponse {
  return {
    id,
    runNumber,
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

function page(
  runs: readonly BacktestRunSummaryResponse[],
  overrides: Partial<BacktestRunPageResponse> = {},
): BacktestRunPageResponse {
  const totalCount = overrides.totalCount ?? runs.length;
  const pageSize = overrides.pageSize ?? 25;
  return {
    runs: [...runs],
    page: 1,
    pageSize,
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
    unfilteredCount: totalCount,
    q: null,
    status: null,
    sort: "newest",
    ...overrides,
  };
}

function completed(count: number, from = 0) {
  return Array.from({ length: count }, (_, index) =>
    summary("COMPLETED", `run-${from + index}`),
  );
}

describe("BacktestsPage", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    searchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A collection row says one thing about a job that has not finished: it is alive.
   *
   * The assertion is on the semantic hook the badge publishes, never on an animation frame — a
   * test that sampled CSS keyframes would be brittle and would prove nothing about the product
   * rule, which is simply that a finished run stays still.
   */
  it("marks queued and running rows as live work, and leaves terminal ones still", async () => {
    fetchMock.mockResolvedValue(
      page([
        summary("QUEUED", "run-queued"),
        summary("RUNNING", "run-running"),
        summary("COMPLETED", "run-completed"),
        summary("FAILED", "run-failed"),
      ]),
    );

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
    // A long run with a large total return but a modest CAGR.
    const runs = Array.from({ length: 10 }, (_, index) => ({
      ...summary("COMPLETED", `run-${index}`),
      portfolioReturnPercent: index === 0 ? 900 : 40 + index,
      portfolioCagrPercent: index === 0 ? 7.9 : 8 + index,
      benchmarkReturnPercent: 50,
      alphaPercent: index === 0 ? 850 : -10 + index,
    }));
    fetchMock.mockResolvedValue(page(runs));
    const user = userEvent.setup();

    render(<BacktestsPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("backtest-card-status")).toHaveLength(10),
    );

    // The CAGR column carries the stored annualized return; excess return is in points.
    const first = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(first).getByText("+7.90%")).toBeTruthy();
    expect(within(first).getByText("+850.00 pp")).toBeTruthy();

    // Ranking is by CAGR, never by the cumulative return, and the API does it over every run.
    const sort = screen.getByRole("combobox", { name: /sort/i });
    expect(
      within(sort).queryByRole("option", { name: "Best return" }),
    ).toBeNull();
    await user.selectOptions(sort, "Best CAGR");
    expect(pushMock).toHaveBeenCalledWith("/backtests?sort=cagr", {
      scroll: false,
    });

    // Folded between 880 and 1,279px, the benchmark joins the total return as a comparison —
    // never the stock-list cell.
    const folded = screen.getAllByTestId("backtest-folded-benchmark")[0]!;
    expect(folded.textContent).toBe("vs Total Market Index +50.00%");
    expect(folded.closest("td")?.getAttribute("data-column")).toBe("portfolio");
    // The stock list folds under the strategy in the same band; it is still the list's link.
    const foldedList = screen.getAllByTestId("backtest-folded-list")[0]!;
    expect(foldedList.closest("td")?.getAttribute("data-column")).toBe("run");
    expect(
      within(foldedList)
        .getByRole("link", { name: /Quality compounders/ })
        .getAttribute("href"),
    ).toBe("/lists/list-1");
  });

  it("asks the API for exactly the view the URL names, and shows its counts", async () => {
    searchParams = new URLSearchParams(
      "page=2&pageSize=10&q=growth&status=FAILED&sort=oldest",
    );
    fetchMock.mockResolvedValue(
      page(completed(10, 10), {
        page: 2,
        pageSize: 10,
        totalCount: 34,
        unfilteredCount: 1_250,
        q: "growth",
        status: "FAILED",
        sort: "oldest",
      }),
    );

    render(<BacktestsPage />);
    await screen.findByTestId("backtests-grid");

    expect(fetchMock).toHaveBeenCalledWith(
      { page: 2, pageSize: 10, q: "growth", status: "FAILED", sort: "oldest" },
      expect.anything(),
    );
    expect(screen.getByTestId("backtests-count").textContent).toBe(
      "34 of 1,250 runs",
    );
    const footer = screen.getByTestId("backtests-footer");
    expect(footer.textContent).toContain("Showing 11–20 of 34 runs");
    expect(footer.textContent).toContain("Page 2 of 4");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe(
      "FAILED",
    );
    expect((screen.getByLabelText("Sort") as HTMLSelectElement).value).toBe(
      "oldest",
    );
    expect(
      (
        screen.getByRole("searchbox", {
          name: "Search runs",
        }) as HTMLInputElement
      ).value,
    ).toBe("growth");
  });

  it("moves pages, sizes, filters and orders through the URL, back to the first page", async () => {
    searchParams = new URLSearchParams("page=2&status=COMPLETED");
    fetchMock.mockResolvedValue(
      page(completed(25), { page: 2, totalCount: 60, unfilteredCount: 80 }),
    );
    const user = userEvent.setup();

    render(<BacktestsPage />);
    const footer = await screen.findByTestId("backtests-footer");

    await user.click(within(footer).getByRole("button", { name: "Next" }));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests?page=3&status=COMPLETED",
      { scroll: false },
    );
    await user.selectOptions(within(footer).getByLabelText("Rows"), "50");
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests?pageSize=50&status=COMPLETED",
      { scroll: false },
    );
    await user.selectOptions(screen.getByLabelText("Status"), "ACTIVE");
    expect(pushMock).toHaveBeenLastCalledWith("/backtests?status=ACTIVE", {
      scroll: false,
    });
    await user.selectOptions(screen.getByLabelText("Status"), "all");
    expect(pushMock).toHaveBeenLastCalledWith("/backtests", { scroll: false });
  });

  it("sorts from the CAGR, Strategy and Queued headers, Queued both ways", async () => {
    fetchMock.mockResolvedValue(page(completed(3)));
    const user = userEvent.setup();

    const { rerender } = render(<BacktestsPage />);
    await screen.findByTestId("backtests-grid");
    const header = (name: string) =>
      screen.getByRole("columnheader", { name: new RegExp(name) });
    expect(header("Queued").getAttribute("aria-sort")).toBe("descending");

    await user.click(within(header("CAGR")).getByRole("button"));
    expect(pushMock).toHaveBeenLastCalledWith("/backtests?sort=cagr", {
      scroll: false,
    });
    await user.click(within(header("Strategy")).getByRole("button"));
    expect(pushMock).toHaveBeenLastCalledWith("/backtests?sort=strategy", {
      scroll: false,
    });
    await user.click(within(header("Queued")).getByRole("button"));
    expect(pushMock).toHaveBeenLastCalledWith("/backtests?sort=oldest", {
      scroll: false,
    });

    // The headers show the order the URL holds.
    searchParams = new URLSearchParams("sort=cagr");
    rerender(<BacktestsPage />);
    await waitFor(() =>
      expect(header("CAGR").getAttribute("aria-sort")).toBe("descending"),
    );
    expect(header("Queued").getAttribute("aria-sort")).toBeNull();
  });

  it("sends a search once typing pauses, replacing the address rather than stacking history", async () => {
    fetchMock.mockResolvedValue(page(completed(12)));
    render(<BacktestsPage />);
    const field = await screen.findByRole("searchbox", { name: "Search runs" });

    vi.useFakeTimers();
    fireEvent.change(field, { target: { value: "g" } });
    fireEvent.change(field, { target: { value: "gro" } });
    fireEvent.change(field, { target: { value: "growth " } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(replaceMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/backtests?q=growth", {
      scroll: false,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("keeps the rows on screen while another page loads, and never shows a page the reader left", async () => {
    let resolveSecond: (value: BacktestRunPageResponse) => void = () =>
      undefined;
    fetchMock
      .mockResolvedValueOnce(page(completed(25), { totalCount: 80 }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      )
      .mockResolvedValueOnce(
        page(completed(25, 50), { page: 3, totalCount: 80 }),
      );

    const { rerender } = render(<BacktestsPage />);
    await screen.findByText("Strategy run-0");

    // Page 2 is asked for and is slow; the reader moves on to page 3 before it lands.
    searchParams = new URLSearchParams("page=2");
    rerender(<BacktestsPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("backtests-footer").getAttribute("aria-busy"),
      ).toBe("true"),
    );
    expect(screen.getByText("Strategy run-0")).toBeTruthy();

    searchParams = new URLSearchParams("page=3");
    rerender(<BacktestsPage />);
    await screen.findByText("Strategy run-50");
    await act(async () => {
      resolveSecond(page(completed(25, 25), { page: 2, totalCount: 80 }));
    });
    expect(screen.queryByText("Strategy run-25")).toBeNull();
    expect(screen.getByText("Strategy run-50")).toBeTruthy();
    expect(
      screen.getByTestId("backtests-footer").getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("re-reads only the page on screen, and only while it shows a run in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    searchParams = new URLSearchParams("page=2");
    fetchMock
      .mockResolvedValueOnce(
        page([summary("RUNNING", "live"), ...completed(2)], {
          page: 2,
          totalCount: 40,
        }),
      )
      .mockResolvedValueOnce(
        page([summary("COMPLETED", "live"), ...completed(2)], {
          page: 2,
          totalCount: 40,
        }),
      );

    render(<BacktestsPage />);
    await screen.findByText("Strategy live");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKTEST_COLLECTION_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The same page of the same view, never the whole history.
    expect(fetchMock.mock.calls[1]?.[0]).toEqual({
      page: 2,
      pageSize: 25,
      sort: "newest",
    });

    // Everything on the page has finished: no further reads however long it stays open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        BACKTEST_COLLECTION_POLL_INTERVAL_MS * 4,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tells no runs yet from none matching, and clears filters back to the history", async () => {
    fetchMock.mockResolvedValueOnce(page([], { unfilteredCount: 0 }));
    const first = render(<BacktestsPage />);
    expect(await screen.findByTestId("backtests-empty")).toBeTruthy();
    expect(screen.queryByTestId("backtests-toolbar")).toBeNull();
    expect(screen.queryByTestId("backtests-count")).toBeNull();
    first.unmount();

    searchParams = new URLSearchParams("q=nothing&status=FAILED");
    fetchMock.mockResolvedValueOnce(
      page([], {
        totalCount: 0,
        unfilteredCount: 14,
        q: "nothing",
        status: "FAILED",
      }),
    );
    const user = userEvent.setup();
    render(<BacktestsPage />);
    const empty = await screen.findByTestId("backtests-filtered-empty");
    expect(empty.textContent).toContain("No runs match “nothing”");
    expect(screen.getByTestId("backtests-count").textContent).toBe(
      "0 of 14 runs",
    );
    await user.click(
      within(empty).getByRole("button", { name: "Clear filters" }),
    );
    expect(pushMock).toHaveBeenLastCalledWith("/backtests", { scroll: false });
  });

  it("keeps the rows when a later read fails, says so, and reads again on request", async () => {
    fetchMock
      .mockResolvedValueOnce(page(completed(25), { totalCount: 40 }))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(
        page(completed(15, 25), { page: 2, totalCount: 40 }),
      );
    const user = userEvent.setup();

    const { rerender } = render(<BacktestsPage />);
    await screen.findByText("Strategy run-0");
    searchParams = new URLSearchParams("page=2");
    rerender(<BacktestsPage />);

    const failed = await screen.findByTestId("backtests-read-failed");
    expect(screen.getByText("Strategy run-0")).toBeTruthy();
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    await screen.findByText("Strategy run-25");
    expect(screen.queryByTestId("backtests-read-failed")).toBeNull();
  });

  it("drops the footer while every run fits on the smallest page, and the redundant row link", async () => {
    fetchMock.mockResolvedValue(page(completed(10)));
    render(<BacktestsPage />);
    await screen.findByTestId("backtests-grid");

    expect(screen.queryByTestId("backtests-footer")).toBeNull();
    expect(screen.getByTestId("backtests-count").textContent).toBe("10 runs");
    // The row opens through its name; there is no second "View results" link in it.
    expect(screen.queryByRole("link", { name: /^View results/ })).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /^Strategy run-0/ })
        .getAttribute("href"),
    ).toBe("/backtests/run-0");
  });
});

describe("the collection's view in the URL", () => {
  it("defaults to the first page of every run, newest first, 25 at a time", () => {
    expect(viewOf(new URLSearchParams())).toEqual({
      page: 1,
      pageSize: 25,
      q: null,
      status: null,
      sort: "newest",
    });
  });

  it("ignores anything the collection does not offer", () => {
    expect(
      viewOf(
        new URLSearchParams(
          "page=-2&pageSize=200&q=%20%20&status=QUEUED&sort=fastest",
        ),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      q: null,
      status: null,
      sort: "newest",
    });
    expect(viewOf(new URLSearchParams(`q=${"x".repeat(101)}`)).q).toBeNull();
  });

  it("reads every offered value", () => {
    expect(
      viewOf(
        new URLSearchParams(
          "page=4&pageSize=100&q=%20value%20&status=ACTIVE&sort=strategy",
        ),
      ),
    ).toEqual({
      page: 4,
      pageSize: 100,
      q: "value",
      status: "ACTIVE",
      sort: "strategy",
    });
  });
});
