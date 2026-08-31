import type { StockSearchResultResponse } from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockSearch } from "./StockSearch";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function result(
  symbol: string,
  name: string,
  overrides: Partial<StockSearchResultResponse> = {},
): StockSearchResultResponse {
  return { symbol, name, exchangeCode: "NASDAQ", ...overrides };
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
