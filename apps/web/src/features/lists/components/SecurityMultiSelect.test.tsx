import type {
  StockListSecurityResponse,
  StockSearchResultResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityMultiSelect } from "./SecurityMultiSelect";

function result(symbol: string, name: string): StockSearchResultResponse {
  return {
    id: `id-${symbol}`,
    symbol,
    name,
    exchangeCode: "NASDAQ",
    exchangeName: "NASDAQ Global Select",
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
});
