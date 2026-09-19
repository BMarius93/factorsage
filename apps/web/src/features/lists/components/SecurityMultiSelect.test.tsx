import type {
  StockListSecurityResponse,
  StockSearchResultResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityMultiSelect } from "./SecurityMultiSelect";

/** Recently viewed stocks are provider state in the application; the suite drives them directly. */
let recentSecurities: StockSearchResultResponse[] = [];

vi.mock("../../stocks/recent/hooks/use-recent-securities", () => ({
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
    exchangeName: "NASDAQ Global Select",
    ...overrides,
  };
}

/** Resolves every search request with the same rows. */
function respondWith(rows: readonly StockSearchResultResponse[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => rows,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type HarnessProps = {
  readonly excludedIds?: ReadonlySet<string>;
  readonly onChangeSpy?: (next: StockListSecurityResponse[]) => void;
};

/** Owns the selection state the way the real dialogs do. */
function Harness({ excludedIds, onChangeSpy }: HarnessProps) {
  const [selected, setSelected] = useState<StockListSecurityResponse[]>([]);
  return (
    <SecurityMultiSelect
      selected={selected}
      onChange={(next) => {
        onChangeSpy?.(next);
        setSelected(next);
      }}
      {...(excludedIds ? { excludedIds } : {})}
    />
  );
}

async function typeQuery(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.click(screen.getByRole("combobox"));
  await user.keyboard(text);
  await vi.advanceTimersByTimeAsync(300);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  recentSecurities = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SecurityMultiSelect", () => {
  it("shows catalog results as SYMBOL — name rows and selects one by click into a chip", async () => {
    respondWith([result("NVDA", "NVIDIA Corporation"), result("NVAX", "Novavax")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "nv");

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(screen.getByText("NVIDIA Corporation")).toBeDefined();

    await user.click(screen.getByText("NVIDIA Corporation"));

    expect(screen.getByLabelText("Remove NVDA")).toBeDefined();
    // The query resets so the next search starts clean.
    expect(screen.getByRole("combobox").getAttribute("value")).toBe("");
  });

  it("identifies a pickable stock with the shared mark, and carries it onto the selection", async () => {
    const onChangeSpy = vi.fn();
    respondWith([
      result("NVDA", "NVIDIA Corporation", {
        logoUrl: "https://images.financialmodelingprep.com/symbol/NVDA.png",
      }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness onChangeSpy={onChangeSpy} />);
    await typeQuery(user, "nv");

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(
      screen.getByRole("option").querySelector("img")?.getAttribute("src"),
    ).toBe("/api/logo/NVDA");

    await user.click(screen.getByText("NVIDIA Corporation"));

    // The picked row keeps its projected mark, so the list this builds renders identically
    // before and after it is saved and re-read.
    expect(onChangeSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        symbol: "NVDA",
        logoUrl: "https://images.financialmodelingprep.com/symbol/NVDA.png",
      }),
    ]);
  });

  it("selects the highlighted result with ArrowDown + Enter", async () => {
    respondWith([result("AAPL", "Apple Inc."), result("AAP", "Advance Auto Parts")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "aap");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(screen.getByLabelText("Remove AAP")).toBeDefined();
    expect(screen.queryByLabelText("Remove AAPL")).toBeNull();
  });

  it("takes the strongest match on Enter when nothing is highlighted", async () => {
    respondWith([result("MSFT", "Microsoft Corporation")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "msft");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });

    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Remove MSFT")).toBeDefined();
  });

  it("never creates a chip from free text without a catalog match", async () => {
    respondWith([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "not-a-stock");
    await waitFor(() => {
      expect(screen.getByText(/No stocks match/)).toBeDefined();
    });

    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
  });

  it("prevents duplicates: picking an already selected row unselects it", async () => {
    respondWith([result("AAPL", "Apple Inc.")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "aapl");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    await user.click(screen.getByText("Apple Inc."));
    expect(screen.getByLabelText("Remove AAPL")).toBeDefined();

    // The same row now reads as selected; picking it again removes the chip.
    await typeQuery(user, "aapl");
    await waitFor(() => {
      expect(screen.getByText("Selected")).toBeDefined();
    });
    await user.click(screen.getByText("Apple Inc."));
    expect(screen.queryByLabelText("Remove AAPL")).toBeNull();
  });

  it("removes a chip from its × button and with Backspace on an empty query", async () => {
    respondWith([result("AAPL", "Apple Inc."), result("MSFT", "Microsoft")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "a");
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByText("Apple Inc."));
    await typeQuery(user, "m");
    await waitFor(() => {
      expect(screen.getByText("Microsoft")).toBeDefined();
    });
    await user.click(screen.getByText("Microsoft"));
    expect(screen.getByLabelText("Remove AAPL")).toBeDefined();
    expect(screen.getByLabelText("Remove MSFT")).toBeDefined();

    await user.click(screen.getByLabelText("Remove AAPL"));
    expect(screen.queryByLabelText("Remove AAPL")).toBeNull();

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Backspace}");
    expect(screen.queryByLabelText("Remove MSFT")).toBeNull();
  });

  it("annotates excluded rows as already in the list and refuses to select them", async () => {
    respondWith([result("AAPL", "Apple Inc.")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness excludedIds={new Set(["id-AAPL"])} />);
    await typeQuery(user, "aapl");
    await waitFor(() => {
      expect(screen.getByText("In list")).toBeDefined();
    });

    await user.click(screen.getByText("Apple Inc."));
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Remove AAPL")).toBeNull();
  });

  it("offers recently viewed stocks on a blank field, like the topbar, but no uncatalogued shortcuts (UI-035)", async () => {
    const fetchMock = respondWith([]);
    recentSecurities = [result("MSFT", "Microsoft")];
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("Recently Viewed")).toBeDefined();
    expect(screen.queryByText("Popular Stocks")).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Remove MSFT")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the multi-select model: a labelled, multiselectable listbox where selected means chosen", async () => {
    respondWith([result("AAPL", "Apple Inc."), result("AMZN", "Amazon")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "a");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-labelledby")).toBeTruthy();
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");

    // Highlighting is not choosing.
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected")),
    ).toEqual(["false", "false"]);
  });

  it("says why a throttled search failed, in the API's words, and hides retry inside the wait (UI-036)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({ code: "RATE_LIMITED", retryAfterSeconds: 42 }),
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<Harness />);
    await typeQuery(user, "aapl");

    expect((await screen.findByRole("status")).textContent).toBe(
      "Too many requests. Please try again in 42 seconds.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("closes an open list on Escape without closing the dialog around it, and lets Escape through once closed", async () => {
    respondWith([result("AAPL", "Apple Inc.")]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onParentEscape = vi.fn();

    render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onParentEscape();
          }
        }}
      >
        <Harness />
      </div>,
    );
    await typeQuery(user, "aapl");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeDefined());

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onParentEscape).not.toHaveBeenCalled();
    // Focus stays in the field.
    expect(document.activeElement).toBe(screen.getByRole("combobox"));

    await user.keyboard("{Escape}");
    expect(onParentEscape).toHaveBeenCalledTimes(1);
  });

  it("closes the list after a pick and when focus leaves, so it never covers the dialog's buttons", async () => {
    respondWith([result("AAPL", "Apple Inc.")]);
    recentSecurities = [result("MSFT", "Microsoft")];
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <>
        <Harness />
        <button type="button">Create list</button>
      </>,
    );
    await typeQuery(user, "aapl");
    await waitFor(() => expect(screen.getByRole("option")).toBeDefined());
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Remove AAPL")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));

    // Clicking the field again offers the recents; tabbing on closes them.
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeDefined();
    await user.tab();
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is not expanded on a blank field with nothing to offer, so Escape reaches the dialog", async () => {
    respondWith([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onParentEscape = vi.fn();
    render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onParentEscape();
          }
        }}
      >
        <Harness />
      </div>,
    );
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await user.keyboard("{Escape}");
    expect(onParentEscape).toHaveBeenCalledTimes(1);
  });
});
