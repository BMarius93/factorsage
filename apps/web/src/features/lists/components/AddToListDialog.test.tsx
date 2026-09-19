import type {
  StockListDetailResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  addStockListItems,
  fetchStockList,
  fetchStockLists,
} from "../api/stock-lists-api";
import { AddToListDialog } from "./AddToListDialog";

vi.mock("../api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
  fetchStockList: vi.fn(),
  addStockListItems: vi.fn(),
}));

const fetchListsMock = vi.mocked(fetchStockLists);
const fetchListMock = vi.mocked(fetchStockList);
const addMock = vi.mocked(addStockListItems);

function summary(
  id: string,
  name: string,
  ownership: "USER" | "SYSTEM" = "USER",
): StockListSummaryResponse {
  return {
    ownership,
    canEdit: ownership === "USER",
    id,
    name,
    itemCount: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    compliance: { symbolCount: 1, symbolLimit: 10, compliant: true },
  };
}

function detail(
  id: string,
  memberIds: readonly string[],
): StockListDetailResponse {
  return {
    ...summary(id, id),
    items: memberIds.map((securityId) => ({
      id: `item-${securityId}`,
      security: {
        id: securityId,
        symbol: securityId.toUpperCase(),
        name: securityId,
        exchangeCode: "NASDAQ",
      },
      buyWindowMode: "FULL",
      buyWindows: [],
    })),
  };
}

const SECURITY = { id: "sec-aapl", symbol: "AAPL" };
const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  fetchListsMock.mockResolvedValue([
    summary("mine", "Watchlist"),
    summary("other", "Dividend picks"),
    summary("builtin", "Nasdaq-100", "SYSTEM"),
  ]);
  fetchListMock.mockImplementation(async (id) =>
    detail(id, id === "other" ? ["sec-aapl"] : []),
  );
});

describe("AddToListDialog (UI-018)", () => {
  it("offers only the caller's own lists and adds the stock to the chosen one", async () => {
    addMock.mockResolvedValue(detail("mine", ["sec-aapl"]));
    const user = userEvent.setup();
    render(<AddToListDialog security={SECURITY} onClose={onClose} />);

    const select = (await screen.findByLabelText("List")) as HTMLSelectElement;
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toEqual(["Select a stock list…", "Watchlist", "Dividend picks"]);

    await user.selectOptions(select, "mine");
    const submit = screen.getByTestId("add-to-list-submit");
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);

    expect(addMock).toHaveBeenCalledWith("mine", { securityIds: ["sec-aapl"] });
    expect(
      (await screen.findByTestId("add-to-list-added")).textContent,
    ).toContain("AAPL is now in Watchlist.");
    expect(
      screen.getByRole("link", { name: "Open list" }).getAttribute("href"),
    ).toBe("/lists/mine");
  });

  it("says when the stock is already in the chosen list and sends nothing", async () => {
    const user = userEvent.setup();
    render(<AddToListDialog security={SECURITY} onClose={onClose} />);

    await user.selectOptions(await screen.findByLabelText("List"), "other");
    expect((await screen.findByTestId("add-to-list-already")).textContent).toBe(
      "AAPL is already in Dividend picks.",
    );
    expect(
      screen.getByTestId("add-to-list-submit").hasAttribute("disabled"),
    ).toBe(true);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("shows a plan refusal in the API's own words", async () => {
    addMock.mockRejectedValue(
      new ApiError(
        403,
        "Your plan allows 10 stocks per list; this change would make 11.",
        "ENTITLEMENT_LIST_SYMBOL_LIMIT",
      ),
    );
    const user = userEvent.setup();
    render(<AddToListDialog security={SECURITY} onClose={onClose} />);

    await user.selectOptions(await screen.findByLabelText("List"), "mine");
    const submit = screen.getByTestId("add-to-list-submit");
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);

    expect(
      (await screen.findByTestId("add-to-list-error")).textContent,
    ).toContain("Your plan allows 10 stocks per list");
  });

  it("points a caller with no lists of their own to creating one", async () => {
    fetchListsMock.mockResolvedValue([
      summary("builtin", "Nasdaq-100", "SYSTEM"),
    ]);
    render(<AddToListDialog security={SECURITY} onClose={onClose} />);

    expect(await screen.findByTestId("add-to-list-no-lists")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Create a list" }).getAttribute("href"),
    ).toBe("/lists?new=1");
  });
});
