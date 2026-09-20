import type {
  StockListDetailResponse,
  StockListItemResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chooseFromOverflowMenu } from "../../../components/ui/__testing__/overflow-menu";
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
    ownership: "USER",
    canEdit: true,
    id: "list-1",
    name: "Growth universe",
    description: "Long-term compounders",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    items,
    compliance: {
      symbolCount: items.length,
      symbolLimit: 100,
      compliant: true,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  push.mockReset();
});

describe("ListDetail", () => {
  it("shows a built-in list read-only to a customer", async () => {
    fetchStockListMock.mockResolvedValue(
      detail(
        [
          item("item-1", "PANW", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2023-06-20", endDate: null }],
          }),
        ],
        {
          ownership: "SYSTEM",
          systemKey: "sp500-growth-leaders",
          canEdit: false,
        },
      ),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    expect(screen.getByTestId("built-in-badge")).toBeDefined();
    expect(screen.getByTestId("membership").textContent).toContain("Present");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("list-detail-actions")).toBeNull();
    expect(screen.queryByTestId("add-stocks-button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Membership for / }),
    ).toBeNull();
  });

  it("lets an administrator edit a built-in list but never offers to delete it", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([item("item-1", "AAPL")], {
        ownership: "SYSTEM",
        systemKey: "sp500-growth-leaders",
        canEdit: true,
      }),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(screen.getByTestId("add-stocks-button")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /^Membership for / }),
    ).toBeDefined();
    expect(screen.queryByTestId("list-detail-actions")).toBeNull();
  });

  it("renders membership beside each member's identity", async () => {
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
    expect(screen.getByText("Always eligible")).toBeDefined();
    // The multi-period member leads with what is true today — a member since 2023 — not with its
    // oldest stored period (UI-019), and every period is in a disclosure rather than a tooltip.
    const membership = screen.getAllByTestId("membership")[1]!;
    expect(membership.getAttribute("data-state")).toBe("CURRENT");
    expect(membership.textContent).toContain("Member now · since Jan 1, 2023");
    expect(
      within(membership).getByTestId("membership-periods-toggle").textContent,
    ).toBe("2 periods");
    const periods = within(membership).getByTestId("membership-periods");
    expect(periods.textContent).toContain("Jan 1, 2020");
    expect(periods.textContent).toContain("Dec 31, 2020");
    expect(membership.hasAttribute("title")).toBe(false);
  });

  it("renders the member's mark from the catalog projection", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([
        item("item-1", "AAPL", {
          security: {
            id: "sec-item-1",
            symbol: "AAPL",
            name: "Apple Incorporated",
            exchangeCode: "NASDAQ",
            logoUrl: "https://images.financialmodelingprep.com/symbol/AAPL.png",
          },
        }),
        item("item-2", "NVDA"),
      ]),
    );

    render(<ListDetail listId="list-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("list-detail")).toBeDefined();
    });

    // Both rows load from the product's own endpoint: the one the catalog has profiled and the
    // one it has not. A member is never condemned to initials by a missing profile row.
    const sources = [...document.querySelectorAll("img")].map((image) =>
      image.getAttribute("src"),
    );
    expect(sources).toContain("/api/logo/AAPL");
    expect(sources).toContain("/api/logo/NVDA");
  });

  it("treats a 404 as not-found without an error alarm", async () => {
    fetchStockListMock.mockRejectedValue(
      new ApiError(404, "Stock list was not found"),
    );

    render(<ListDetail listId="foreign-list" />);

    await waitFor(() => {
      expect(screen.getByTestId("list-not-found")).toBeDefined();
    });
    expect(
      screen.getByText(
        "It may have been deleted, or it belongs to another account.",
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
      new ApiError(
        400,
        "One or more selected securities are not in the supported catalog",
      ),
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

    await chooseFromOverflowMenu(
      userEvent,
      "AAPL in this list",
      "Remove from list",
    );
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

  it("opens the membership editor and renders the canonical saved result", async () => {
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

    // "Membership" is also the column header and each card's label, so the row action is
    // addressed by role rather than by text.
    await userEvent.click(
      screen.getByRole("button", { name: /^Membership for / }),
    );
    expect(screen.getByTestId("membership-editor")).toBeDefined();

    await userEvent.click(
      screen.getByRole("radio", { name: /Membership period/ }),
    );
    await userEvent.type(screen.getByLabelText("From"), "2020-01-01");
    await userEvent.click(screen.getByTestId("save-membership"));

    await waitFor(() => {
      expect(replaceBuyWindowsMock).toHaveBeenCalledWith("list-1", "item-1", {
        mode: "CUSTOM",
        ranges: [{ startDate: "2020-01-01", endDate: null }],
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Present")).toBeDefined();
    });
    expect(screen.getByText("Jan 1, 2020")).toBeDefined();
    expect(screen.queryByTestId("membership-editor")).toBeNull();
  });
});
