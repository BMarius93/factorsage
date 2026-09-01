import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  addStockListItems,
  fetchStockList,
  removeStockListItem,
  replaceBuyWindows,
} from "../api/stock-lists-api";
import { ListDetail } from "./ListDetail";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../api/stock-lists-api", () => ({
  fetchStockList: vi.fn(),
  addStockListItems: vi.fn(),
  removeStockListItem: vi.fn(),
  replaceBuyWindows: vi.fn(),
  deleteStockList: vi.fn(),
  updateStockList: vi.fn(),
}));

// The combobox is covered by its own suite; a probe keeps these tests on membership behaviour.
vi.mock("./SecurityMultiSelect", () => ({
  SecurityMultiSelect: ({
    selected,
    onChange,
    excludedIds,
  }: {
    selected: readonly StockListSecurityResponse[];
    onChange: (next: StockListSecurityResponse[]) => void;
    excludedIds?: ReadonlySet<string>;
  }) => (
    <button
      type="button"
      data-testid="pick-security"
      data-selected-count={selected.length}
      data-excluded={[...(excludedIds ?? [])].join(",")}
      onClick={() =>
        onChange([
          ...selected,
          {
            id: `sec-new-${selected.length + 1}`,
            symbol: `NEW${selected.length + 1}`,
            name: "Newly Picked Corp",
            exchangeCode: "NYSE",
          },
        ])
      }
    >
      Pick security
    </button>
  ),
}));

const fetchStockListMock = vi.mocked(fetchStockList);
const addStockListItemsMock = vi.mocked(addStockListItems);
const removeStockListItemMock = vi.mocked(removeStockListItem);
const replaceBuyWindowsMock = vi.mocked(replaceBuyWindows);

function item(
  id: string,
  symbol: string,
  overrides: Partial<StockListItemResponse> = {},
): StockListItemResponse {
  return {
    id,
    security: {
      id: `sec-${id}`,
      symbol,
      name: `${symbol} Incorporated`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
    },
    buyWindowMode: "FULL",
    buyWindows: [],
    ...overrides,
  };
}

function detail(
  items: StockListItemResponse[],
  overrides: Partial<StockListDetailResponse> = {},
): StockListDetailResponse {
  return {
    id: "list-1",
    name: "Growth universe",
    description: "Long-term compounders",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    items,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  push.mockReset();
});

describe("ListDetail", () => {
  it("renders membership with identity and buy-eligibility state", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([
        item("item-1", "AAPL"),
        item("item-2", "NVDA", {
          buyWindowMode: "CUSTOM",
          buyWindows: [
            { startDate: "2020-01-01", endDate: "2020-12-31" },
            { startDate: "2023-01-01", endDate: null },
          ],
        }),
      ]),
    );

    render(<ListDetail listId="list-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });
    expect(screen.getByText("Growth universe")).toBeDefined();
    expect(screen.getByText("Long-term compounders")).toBeDefined();
    expect(screen.getByText("2 stocks")).toBeDefined();
    expect(screen.getByText("AAPL")).toBeDefined();
    expect(screen.getByText("AAPL Incorporated")).toBeDefined();
    expect(screen.getByText("Full history")).toBeDefined();
    expect(screen.getByText("Custom · 2 windows")).toBeDefined();
  });

  it("treats a 404 as not-found without an error alarm", async () => {
    fetchStockListMock.mockRejectedValue(new ApiError(404, "Stock list was not found"));

    render(<ListDetail listId="foreign-list" />);

    await waitFor(() => {
      expect(screen.getByTestId("list-not-found")).toBeDefined();
    });
    expect(
      screen.getByText(
        "This list does not exist or belongs to a different account.",
      ),
    ).toBeDefined();
  });

  it("adds picked securities through the batch endpoint and renders the API result", async () => {
    fetchStockListMock.mockResolvedValue(detail([item("item-1", "AAPL")]));
    addStockListItemsMock.mockResolvedValue(
      detail([item("item-1", "AAPL"), item("item-2", "NEW1")]),
    );

    render(<ListDetail listId="list-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });

    // Existing members are handed to the search so they cannot be picked again.
    expect(
      screen.getByTestId("pick-security").getAttribute("data-excluded"),
    ).toBe("sec-item-1");

    const addButton = screen.getByTestId("add-stocks-button");
    expect((addButton as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByTestId("pick-security"));
    expect((addButton as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(addButton);

    await waitFor(() => {
      expect(addStockListItemsMock).toHaveBeenCalledWith("list-1", {
        securityIds: ["sec-new-1"],
      });
    });
    await waitFor(() => {
      expect(screen.getByText("NEW1")).toBeDefined();
    });
    // The pending selection clears after a successful add.
    expect(
      screen.getByTestId("pick-security").getAttribute("data-selected-count"),
    ).toBe("0");
  });

  it("surfaces a rejected add without losing the page", async () => {
    fetchStockListMock.mockResolvedValue(detail([item("item-1", "AAPL")]));
    addStockListItemsMock.mockRejectedValue(
      new ApiError(400, "One or more selected securities are not in the supported catalog"),
    );

    render(<ListDetail listId="list-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("pick-security"));
    await userEvent.click(screen.getByTestId("add-stocks-button"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "One or more selected securities are not in the supported catalog",
        ),
      ).toBeDefined();
    });
    expect(screen.getByText("AAPL")).toBeDefined();
  });

  it("removes a stock after confirmation", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([item("item-1", "AAPL"), item("item-2", "NVDA")]),
    );
    removeStockListItemMock.mockResolvedValue(undefined);

    render(<ListDetail listId="list-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });

    await userEvent.click(screen.getByLabelText("Remove AAPL from list"));
    expect(removeStockListItemMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Remove stock" }));

    await waitFor(() => {
      expect(removeStockListItemMock).toHaveBeenCalledWith("list-1", "item-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("AAPL")).toBeNull();
    });
    expect(screen.getByText("NVDA")).toBeDefined();
  });

  it("opens the buy-window editor and renders the canonical saved result", async () => {
    fetchStockListMock.mockResolvedValue(detail([item("item-1", "AAPL")]));
    replaceBuyWindowsMock.mockResolvedValue(
      item("item-1", "AAPL", {
        buyWindowMode: "CUSTOM",
        // The API merged whatever was submitted into one canonical window.
        buyWindows: [{ startDate: "2020-01-01", endDate: null }],
      }),
    );

    render(<ListDetail listId="list-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Buy windows"));
    expect(screen.getByTestId("buy-window-editor")).toBeDefined();

    await userEvent.click(screen.getByText("Custom windows"));
    await userEvent.type(
      screen.getByLabelText("Range 1 start date"),
      "2020-01-01",
    );
    await userEvent.click(screen.getByTestId("save-buy-windows"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "CUSTOM",
        ranges: [{ startDate: "2020-01-01", endDate: null }],
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Custom · 1 window")).toBeDefined();
    });
    expect(screen.queryByTestId("buy-window-editor")).toBeNull();
  });
});
