import type { StockSearchResultResponse } from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsavedChangesGuard } from "../../../../components/layout/unsaved-changes";
import { StockSearch } from "./StockSearch";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

/**
 * The recent set is provider state in the real application; the dropdown only reads it, so the
 * suite drives it directly rather than standing up a session and a provider for every case.
 */
let recentSecurities: StockSearchResultResponse[] = [];

vi.mock("../../recent/hooks/use-recent-securities", () => ({
  useRecentSecurities: () => ({
    securities: recentSecurities,
    record: vi.fn(),
  }),
}));

function result(
  symbol: string,
  name: string,
  overrides: Partial<StockSearchResultResponse> = {},
): StockSearchResultResponse {
  return {
    id: `id-${symbol}`,
    symbol,
    name,
    exchangeCode: "NASDAQ",
    ...overrides,
  };
}

/** Resolves `fetch` with the given rows, in call order. */
function respondWith(...batches: readonly StockSearchResultResponse[][]) {
  const fetchMock = vi.fn();
  for (const batch of batches) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => batch,
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function optionTexts(): string[] {
  return screen
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

async function typeQuery(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.click(screen.getByRole("combobox"));
  await user.keyboard(text);
}

beforeEach(() => {
  push.mockReset();
  recentSecurities = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StockSearch", () => {
  it("shows exactly the three popular searches when focused with an empty query", async () => {
    const fetchMock = respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("Popular Searches")).toBeDefined();
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "AAPLApple",
      "MSFTMicrosoft",
      "NVDANVIDIA",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never issues a search request for a blank or whitespace-only query", async () => {
    const fetchMock = respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "   ");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Popular Searches")).toBeDefined();
  });

  it("replaces the popular searches with real results once a query is typed", async () => {
    const fetchMock = respondWith([
      result("AAPL", "Apple Inc.", { exchangeName: "NASDAQ Global Select" }),
      result("AAP", "Advance Auto Parts"),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "aap");
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      expect(optionTexts()).toEqual([
        "AAPLApple Inc.NASDAQ Global Select",
        "AAPAdvance Auto PartsNASDAQ",
      ]);
    });
    expect(screen.queryByText("Popular Searches")).toBeNull();

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("/stocks/search");
    expect(requestedUrl).toContain("q=aap");
  });

  it("debounces typing into a single request", async () => {
    const fetchMock = respondWith([result("NVDA", "NVIDIA Corporation")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "nvda");
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("navigates to the stock route when a popular search is selected", async () => {
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /AAPL/ }));

    expect(push).toHaveBeenCalledWith("/stocks/AAPL");
  });

  it("navigates to the stock route when a search result is selected", async () => {
    respondWith([result("MSFT", "Microsoft Corporation")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "micro");
    await vi.advanceTimersByTimeAsync(300);

    await user.click(await screen.findByRole("option", { name: /MSFT/ }));

    expect(push).toHaveBeenCalledWith("/stocks/MSFT");
    // The dropdown closes and the query resets so the next focus starts clean.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox")).toHaveProperty("value", "");
  });

  it("does not let a slow older response replace newer results", async () => {
    let resolveStale: (value: unknown) => void = () => {};
    const stale = new Promise((resolve) => {
      resolveStale = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [result("NVDA", "NVIDIA Corporation")],
      });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StockSearch />);

    await typeQuery(user, "nv");
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.keyboard("da");
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(optionTexts()).toEqual(["NVDANVIDIA CorporationNASDAQ"]),
    );

    // The first query's response only lands now; it must be discarded.
    resolveStale({
      ok: true,
      json: async () => [result("NVAX", "Novavax")],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(optionTexts()).toEqual(["NVDANVIDIA CorporationNASDAQ"]);
  });

  it("moves through results with the arrow keys and selects with Enter", async () => {
    respondWith([
      result("AAPL", "Apple Inc."),
      result("AAP", "Advance Auto Parts"),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "aap");
    await vi.advanceTimersByTimeAsync(300);
    await screen.findByRole("option", { name: /AAPL/ });

    await user.keyboard("{ArrowDown}{ArrowDown}");
    const options = screen.getAllByRole("option");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("combobox").getAttribute("aria-activedescendant"),
    ).toBe(options[1]?.id);

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/stocks/AAP");
  });

  it("wraps the highlight from the first option upward to the last", async () => {
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowUp}{Enter}");

    expect(push).toHaveBeenCalledWith("/stocks/NVDA");
  });

  it("closes on Escape and on an outside click", async () => {
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <div>
        <StockSearch />
        <button type="button">outside</button>
      </div>,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reports an empty result set for the typed query", async () => {
    respondWith([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "zzzz");
    await vi.advanceTimersByTimeAsync(300);

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "No stocks match “zzzz”.",
    );
  });

  it("offers a recoverable error state when the search request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [result("AAPL", "Apple Inc.")],
      });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<StockSearch />);
    await typeQuery(user, "aapl");
    await vi.advanceTimersByTimeAsync(300);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Search is unavailable right now.");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() =>
      expect(optionTexts()).toEqual(["AAPLApple Inc.NASDAQ"]),
    );
  });
});

/**
 * Search is in the shared topbar, so selecting a stock leaves whatever page is open. A page
 * holding an unsaved draft must get the same say it gets over a navigation link.
 */
describe("StockSearch with an unsaved page", () => {
  function GuardedPage() {
    useUnsavedChangesGuard(true, "Leave and discard?");
    return null;
  }

  it("stays put and keeps the query when the user cancels leaving", async () => {
    respondWith();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <>
        <GuardedPage />
        <StockSearch />
      </>,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /AAPL/ }));

    expect(confirm).toHaveBeenCalledWith("Leave and discard?");
    expect(push).not.toHaveBeenCalled();
    // Nothing about the search was reset, so the user can pick again without retyping.
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("navigates once the user confirms leaving", async () => {
    respondWith();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <>
        <GuardedPage />
        <StockSearch />
      </>,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /AAPL/ }));

    expect(push).toHaveBeenCalledWith("/stocks/AAPL");
  });

  it("asks nothing when no page has unsaved work", async () => {
    respondWith();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /AAPL/ }));

    expect(confirm).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/stocks/AAPL");
  });
});

/**
 * RECENT SEARCHES is a second shortcut section above POPULAR SEARCHES. It is a reading surface
 * only: the dropdown never records anything, because what a user typed is not what the feature
 * remembers — `useRecordSecurityView` on the Stock Details page is.
 */
describe("StockSearch recent searches", () => {
  const AAPL = result("AAPL", "Apple");
  const NVDA = result("NVDA", "NVIDIA");
  const MSFT = result("MSFT", "Microsoft");

  function sectionLabels(): string[] {
    return screen
      .getAllByText(/Recent Searches|Popular Searches|Results/)
      .map((element) => element.textContent ?? "");
  }

  it("shows recents above the popular searches when the query is empty", async () => {
    recentSecurities = [AAPL, NVDA, MSFT];
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    expect(sectionLabels()).toEqual(["Recent Searches", "Popular Searches"]);
    // Recent rows carry the same ticker/company treatment as the popular rows below them, with no
    // exchange badge and no extra controls.
    expect(optionTexts()).toEqual([
      "AAPLApple",
      "NVDANVIDIA",
      "MSFTMicrosoft",
      "AMZNAmazon",
      "GOOGLAlphabet",
      "METAMeta Platforms",
    ]);
  });

  it("omits the recent heading entirely when there is nothing to show", async () => {
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    expect(screen.queryByText("Recent Searches")).toBeNull();
    expect(sectionLabels()).toEqual(["Popular Searches"]);
  });

  it("never repeats a stock that is already in the recent section", async () => {
    recentSecurities = [AAPL, NVDA];
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    const symbols = optionTexts();
    expect(symbols.filter((text) => text.startsWith("AAPL"))).toHaveLength(1);
    expect(symbols.filter((text) => text.startsWith("NVDA"))).toHaveLength(1);
    // The popular section backfills rather than shrinking.
    expect(symbols.slice(2)).toEqual([
      "MSFTMicrosoft",
      "AMZNAmazon",
      "GOOGLAlphabet",
    ]);
  });

  it("shows at most five recents", async () => {
    recentSecurities = ["A", "B", "C", "D", "E"].map((symbol) =>
      result(symbol, `Company ${symbol}`),
    );
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    expect(optionTexts().slice(0, 5)).toEqual([
      "ACompany A",
      "BCompany B",
      "CCompany C",
      "DCompany D",
      "ECompany E",
    ]);
    expect(screen.getByText("Popular Searches")).toBeDefined();
  });

  it("hides both shortcut sections while a query is being typed, and restores them when it is cleared", async () => {
    recentSecurities = [AAPL];
    respondWith([result("MSFT", "Microsoft Corporation")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await typeQuery(user, "micro");
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() =>
      expect(optionTexts()).toEqual(["MSFTMicrosoft CorporationNASDAQ"]),
    );
    expect(screen.queryByText("Recent Searches")).toBeNull();
    expect(screen.queryByText("Popular Searches")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(sectionLabels()).toEqual(["Recent Searches", "Popular Searches"]);
    expect(optionTexts()[0]).toBe("AAPLApple");
  });

  it("navigates from a recent row exactly like any other stock row", async () => {
    recentSecurities = [NVDA];
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /NVDA/ }));

    expect(push).toHaveBeenCalledWith("/stocks/NVDA");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps arrow-key navigation running across both sections", async () => {
    recentSecurities = [NVDA];
    respondWith();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<StockSearch />);
    await user.click(screen.getByRole("combobox"));

    // First option is the single recent; the second is the first popular shortcut below it.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(push).toHaveBeenCalledWith("/stocks/AAPL");
  });
});
