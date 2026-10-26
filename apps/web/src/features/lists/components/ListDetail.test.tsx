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
import { entitlementRefusal } from "../../../lib/api/__testing__/request-failures";
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

  it("explains a maintained point-in-time universe and keeps it read-only even for an administrator", async () => {
    fetchStockListMock.mockResolvedValue(
      detail(
        [
          item("item-1", "AAPL", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "1996-01-02", endDate: null }],
          }),
          item("item-2", "LEHMQ", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "1996-01-02", endDate: "2008-09-15" }],
          }),
        ],
        {
          ownership: "SYSTEM",
          systemKey: "sp500-historical-pit",
          // The API answers false for the maintained universe, administrators included.
          canEdit: false,
          universe: {
            kind: "POINT_IN_TIME_INDEX",
            indexKey: "SP500",
            universeKey: "sp500-historical-pit",
            category: "MARKET_INDICES",
            derived: false,
            distinctSecurities: 2,
            peakSimultaneousMembers: 2,
            currentMembers: 1,
            membershipFloor: "1996-01-02",
            syncedAt: "2026-10-17T10:00:00.000Z",
          },
        },
      ),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    expect(screen.getByTestId("universe-badge").textContent).toContain(
      "up to 2 at once",
    );
    const notice = (screen.getByTestId("universe-notice").textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    expect(notice).toContain("1 current members and 1 former ones");
    expect(notice).toContain("buys each stock only while it was a member");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("add-stocks-button")).toBeNull();
  });

  it("explains a derived universe by how it is selected, not by the index's floor", async () => {
    fetchStockListMock.mockResolvedValue(
      detail(
        [
          item("item-1", "AAPL", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2016-01-30", endDate: null }],
          }),
        ],
        {
          ownership: "SYSTEM",
          systemKey: "sp500-top100-market-cap",
          canEdit: false,
          universe: {
            kind: "POINT_IN_TIME_INDEX",
            indexKey: "SP500",
            universeKey: "sp500-top100-market-cap",
            category: "MARKET_CAPITALIZATION",
            derived: true,
            distinctSecurities: 1,
            peakSimultaneousMembers: 1,
            currentMembers: 1,
            membershipFloor: "1996-01-02",
            syncedAt: null,
          },
        },
      ),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    const notice = (screen.getByTestId("universe-notice").textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    expect(notice).toContain("Selected at each reconstitution");
    expect(notice).toContain("using only data available on that date");
    expect(notice).not.toContain("1996");
  });

  it("discloses a retrospectively classified universe's classification and its coverage by year", async () => {
    fetchStockListMock.mockResolvedValue(
      detail(
        [
          item("item-1", "KO", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "1996-01-02", endDate: null }],
          }),
        ],
        {
          ownership: "SYSTEM",
          systemKey: "sp500-defensive",
          canEdit: false,
          universe: {
            kind: "POINT_IN_TIME_INDEX",
            indexKey: "SP500",
            universeKey: "sp500-defensive",
            category: "ECONOMIC_SUPERSECTORS",
            derived: true,
            distinctSecurities: 162,
            peakSimultaneousMembers: 101,
            currentMembers: 80,
            membershipFloor: "1996-01-02",
            syncedAt: null,
            classification: {
              timing: "RETROSPECTIVE",
              scheme: "CURRENT_SECTOR",
              methodLabel: "Current sector applied retrospectively",
              underlyingIndex: "S&P 500",
              sectors: ["Consumer Staples", "Health Care", "Utilities"],
              disclosure:
                "Historical S&P 500 membership with retrospective sector classification. Sector assignments reflect currently available classifications and may differ from historical classifications.",
            },
            coverage: {
              reliableFrom: "2016-01-29",
              priceCoverageFrom: "2003-12-31",
              indexSecurities: 735,
              unclassifiedSecurities: 2,
              warnings: [],
              byYear: [
                {
                  year: "1996",
                  indexLines: 500,
                  indexMembers: 262,
                  classified: 261,
                  unclassified: 1,
                  groupMembers: 61,
                  groupPriced: 55,
                  constituentCoverage: 0.524,
                  classifiedShare: 0.996,
                  priceCoverage: 0.9016,
                  minPriceCoverage: 0.88,
                },
              ],
            },
          },
        },
      ),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    expect(screen.getByTestId("universe-retrospective-badge").textContent).toBe(
      "Retrospective classification",
    );
    const notice = (screen.getByTestId("universe-notice").textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    // Its membership is the index's own; only its classification is today's.
    expect(notice).toContain("The S&P 500's point-in-time membership since");
    expect(notice).toContain("whose current sector is in this group");
    expect(notice).not.toContain("Selected at each reconstitution");
    expect(
      screen.getByTestId("universe-classification-disclosure").textContent,
    ).toBe(
      "Historical S&P 500 membership with retrospective sector classification. Sector assignments reflect currently available classifications and may differ from historical classifications.",
    );
    expect(
      screen.getByTestId("universe-classification-sectors").textContent,
    ).toBe("Consumer Staples, Health Care, Utilities");
    expect(
      screen.getByTestId("universe-classification-method").textContent,
    ).toBe("Current sector applied retrospectively");
    const coverage =
      screen.getByTestId("universe-classification-coverage").textContent ?? "";
    expect(coverage).toContain("lean toward survivors");
    expect(coverage).toContain(
      "2 of 735 S&P 500 stocks have no available sector",
    );
    const byYear = screen.getByTestId("universe-coverage-by-year");
    expect(byYear.textContent).toContain("1996");
    expect(byYear.textContent).toContain("262 of 500 (52%)");
    expect(byYear.textContent).toContain("55 (90%)");
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

describe("ListDetail members, paged and filtered", () => {
  const symbolOf = (index: number) => `S${String(index).padStart(3, "0")}`;
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      item(`item-${index}`, symbolOf(index)),
    );
  const rowSymbols = () =>
    within(screen.getByTestId("list-items"))
      .getAllByTestId("list-item")
      .map((row) => row.querySelector('[data-column="stock"]')?.textContent);

  it("pages the members 25 at a time, with the count in the heading", async () => {
    fetchStockListMock.mockResolvedValue(detail(many(60)));
    render(<ListDetail listId="list-1" />);
    await screen.findByTestId("list-items");

    expect(screen.getAllByTestId("list-item")).toHaveLength(25);
    expect(screen.getByTestId("list-items-count").textContent).toBe(
      "60 stocks",
    );
    const footer = screen.getByTestId("list-items-footer");
    expect(footer.textContent).toContain("Showing 1–25 of 60 stocks");
    const size = within(footer).getByLabelText("Rows") as HTMLSelectElement;
    expect([...size.options].map((option) => option.value)).toEqual([
      "10",
      "25",
      "50",
      "100",
    ]);
    await userEvent.click(within(footer).getByRole("button", { name: "Next" }));
    expect(screen.getAllByTestId("list-item")).toHaveLength(25);
    expect(rowSymbols()[0]).toContain("S025");
  });

  it("offers no membership filter, and no footer, for a short list of always-eligible stocks", async () => {
    fetchStockListMock.mockResolvedValue(detail(many(8)));
    render(<ListDetail listId="list-1" />);
    await screen.findByTestId("list-items");

    expect(screen.queryByTestId("list-membership-filter")).toBeNull();
    expect(screen.queryByTestId("list-items-footer")).toBeNull();
    expect(screen.getAllByTestId("list-item")).toHaveLength(8);
  });

  it("shows current, former or all members of a dated list", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([
        item("always", "FULL1"),
        item("now", "NOW1", {
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "2020-01-01", endDate: null }],
        }),
        item("left", "LEFT1", {
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "2019-01-01", endDate: "2020-12-31" }],
        }),
        item("later", "LATER1", {
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "2999-01-01", endDate: null }],
        }),
      ]),
    );
    const user = userEvent.setup();
    render(<ListDetail listId="list-1" />);
    await screen.findByTestId("list-items");

    const filter = screen.getByTestId("list-membership-filter");
    expect(rowSymbols()).toHaveLength(4);

    await user.selectOptions(filter, "current");
    expect(rowSymbols().map((text) => text?.slice(0, 4))).toEqual([
      "FULL",
      "NOW1",
    ]);
    expect(screen.getByTestId("list-items-count").textContent).toBe(
      "2 of 4 stocks",
    );

    await user.selectOptions(filter, "former");
    expect(rowSymbols().map((text) => text?.slice(0, 5))).toEqual(["LEFT1"]);

    await user.selectOptions(filter, "all");
    expect(rowSymbols()).toHaveLength(4);
  });

  it("says when a membership filter leaves nothing, and shows everything again", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([
        item("now", "NOW1", {
          buyWindowMode: "CUSTOM",
          buyWindows: [{ startDate: "2020-01-01", endDate: null }],
        }),
      ]),
    );
    const user = userEvent.setup();
    render(<ListDetail listId="list-1" />);
    await screen.findByTestId("list-items");

    await user.selectOptions(
      screen.getByTestId("list-membership-filter"),
      "former",
    );
    const empty = screen.getByTestId("list-items-membership-empty");
    expect(empty.textContent).toContain("No former members");
    await user.click(
      within(empty).getByRole("button", { name: "Show all members" }),
    );
    expect(rowSymbols()).toHaveLength(1);
  });

  it("takes the reader to a stock just added, on whatever page and behind whatever filter", async () => {
    const dated = [
      item("left", "LEFT1", {
        buyWindowMode: "CUSTOM",
        buyWindows: [{ startDate: "2019-01-01", endDate: "2020-12-31" }],
      }),
      ...many(59),
    ];
    fetchStockListMock.mockResolvedValue(detail(dated));
    // The API answers in list order, the new stock last: the third page of 25.
    addStockListItemsMock.mockResolvedValue(
      detail([
        ...dated,
        item("item-new", "NEW1", {
          security: {
            id: "sec-new-1",
            symbol: "NEW1",
            name: "Newly Picked Corp",
            exchangeCode: "NYSE",
          },
        }),
      ]),
    );
    const user = userEvent.setup();
    render(<ListDetail listId="list-1" />);
    await screen.findByTestId("list-items");

    // The reader is looking at former members only, which the new stock is not.
    await user.selectOptions(
      screen.getByTestId("list-membership-filter"),
      "former",
    );
    await user.click(screen.getByTestId("pick-security"));
    await user.click(screen.getByTestId("add-stocks-button"));

    await waitFor(() =>
      expect(screen.getByTestId("list-items-footer").textContent).toContain(
        "Page 3 of 3",
      ),
    );
    expect(
      (screen.getByTestId("list-membership-filter") as HTMLSelectElement).value,
    ).toBe("all");
    const newRow = () =>
      within(screen.getByTestId("list-items"))
        .getAllByTestId("list-item")
        .find((row) => row.textContent?.includes("NEW1"));
    await waitFor(() =>
      expect(newRow()?.getAttribute("data-highlight")).toBe("true"),
    );
    expect(
      screen.getByText("NEW1 added to the list.").getAttribute("role"),
    ).toBe("status");

    // The tint is a moment, not a state.
    await waitFor(
      () => expect(newRow()?.getAttribute("data-highlight")).toBeNull(),
      { timeout: 4_000 },
    );
  });
});

describe("ListDetail premium built-ins", () => {
  it("explains a locked premium list instead of failing to load it (403)", async () => {
    fetchStockListMock.mockRejectedValue(
      entitlementRefusal(
        "ENTITLEMENT_PREMIUM_CONTENT",
        "Your plan does not include premium point-in-time universes",
      ),
    );
    render(<ListDetail listId="sp500-pit" />);

    const locked = await screen.findByTestId("list-locked");
    expect(within(locked).getByRole("heading", { level: 1 }).textContent).toBe(
      "This list is premium content",
    );
    expect(locked.textContent).toContain(
      "Its members are included in Pro and Pro+, where it can also be backtested and duplicated.",
    );
    expect(
      within(locked)
        .getByRole("link", { name: "See plans" })
        .getAttribute("href"),
    ).toBe("/pricing");
    expect(
      within(locked)
        .getByRole("link", { name: "Back to Lists" })
        .getAttribute("href"),
    ).toBe("/lists");
    // Not an outage: no retry that could never work, and no member view, backtest or copy.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByTestId("list-detail")).toBeNull();
    expect(screen.queryByTestId("list-items")).toBeNull();
    expect(screen.queryByTestId("run-backtest")).toBeNull();
  });

  it("still reports an ordinary failure as one", async () => {
    fetchStockListMock.mockRejectedValue(new ApiError(500, "Internal error"));
    render(<ListDetail listId="list-1" />);

    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeDefined();
    expect(screen.queryByTestId("list-locked")).toBeNull();
  });

  it("badges a premium list the viewer's plan includes, and keeps its members and backtest", async () => {
    fetchStockListMock.mockResolvedValue(
      detail([item("item-1", "AAPL")], {
        ownership: "SYSTEM",
        systemKey: "sp500-historical-pit",
        canEdit: false,
        premium: true,
      }),
    );
    render(<ListDetail listId="list-1" />);

    await screen.findByTestId("list-detail");
    const badge = screen.getByTestId("premium-badge");
    expect(badge.textContent).toBe("Premium");
    expect(badge.getAttribute("data-locked")).toBeNull();
    expect(screen.getByTestId("built-in-badge")).toBeDefined();
    expect(screen.getByTestId("list-items")).toBeDefined();
    expect(screen.getByTestId("run-backtest")).toBeDefined();
  });
});
