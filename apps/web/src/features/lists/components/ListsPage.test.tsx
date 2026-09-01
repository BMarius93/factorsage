import type {
  StockListDetailResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStockList,
  deleteStockList,
  fetchStockLists,
  updateStockList,
} from "../api/stock-lists-api";
import { ListsPage } from "./ListsPage";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
  createStockList: vi.fn(),
  updateStockList: vi.fn(),
  deleteStockList: vi.fn(),
}));

const fetchStockListsMock = vi.mocked(fetchStockLists);
const createStockListMock = vi.mocked(createStockList);
const updateStockListMock = vi.mocked(updateStockList);
const deleteStockListMock = vi.mocked(deleteStockList);

function summary(
  id: string,
  name: string,
  overrides: Partial<StockListSummaryResponse> = {},
): StockListSummaryResponse {
  return {
    id,
    name,
    itemCount: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function detail(id: string, name: string): StockListDetailResponse {
  return {
    id,
    name,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    items: [],
  };
}

beforeEach(() => {
  push.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ListsPage", () => {
  it("shows the empty state with a create call to action", async () => {
    fetchStockListsMock.mockResolvedValue([]);

    render(<ListsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("lists-empty")).toBeDefined();
    });
    expect(screen.getByText("Create your first list")).toBeDefined();
  });

  it("renders list cards with stock counts and descriptions", async () => {
    fetchStockListsMock.mockResolvedValue([
      summary("list-1", "Dividend picks", {
        itemCount: 3,
        description: "Compounders",
      }),
      summary("list-2", "Tech universe", { itemCount: 1 }),
    ]);

    render(<ListsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("lists-grid")).toBeDefined();
    });
    expect(screen.getByText("Dividend picks")).toBeDefined();
    expect(screen.getByText("Compounders")).toBeDefined();
    expect(screen.getByText("3 stocks")).toBeDefined();
    expect(screen.getByText("1 stock")).toBeDefined();
  });

  it("reports a load failure and recovers through retry", async () => {
    fetchStockListsMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([summary("list-1", "Recovered")]);

    render(<ListsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Your lists could not be loaded"),
      ).toBeDefined();
    });

    await userEvent.click(screen.getByText("Try again"));

    await waitFor(() => {
      expect(screen.getByText("Recovered")).toBeDefined();
    });
  });

  it("creates a list from the dialog and navigates to it", async () => {
    fetchStockListsMock.mockResolvedValue([]);
    createStockListMock.mockResolvedValue(detail("new-list", "My universe"));

    render(<ListsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("lists-empty")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Create your first list"));
    await userEvent.type(screen.getByLabelText("Name"), "My universe");
    await userEvent.click(screen.getByText("Create list"));

    await waitFor(() => {
      expect(createStockListMock).toHaveBeenCalledWith({
        name: "My universe",
      });
    });
    expect(push).toHaveBeenCalledWith("/lists/new-list");
  });

  it("requires a name before creating", async () => {
    fetchStockListsMock.mockResolvedValue([]);

    render(<ListsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("lists-empty")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Create your first list"));
    await userEvent.click(screen.getByText("Create list"));

    expect(screen.getByText("A list needs a name.")).toBeDefined();
    expect(createStockListMock).not.toHaveBeenCalled();
  });

  it("renames a list through the edit dialog", async () => {
    fetchStockListsMock.mockResolvedValue([summary("list-1", "Old name")]);
    updateStockListMock.mockResolvedValue(summary("list-1", "New name"));

    render(<ListsPage />);
    await waitFor(() => {
      expect(screen.getByText("Old name")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Rename"));
    const nameInput = screen.getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "New name");
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("New name")).toBeDefined();
    });
    expect(updateStockListMock).toHaveBeenCalledWith("list-1", {
      name: "New name",
      description: null,
    });
    expect(screen.queryByText("Old name")).toBeNull();
  });

  it("deletes a list only after confirmation", async () => {
    fetchStockListsMock.mockResolvedValue([summary("list-1", "Doomed")]);
    deleteStockListMock.mockResolvedValue(undefined);

    render(<ListsPage />);
    await waitFor(() => {
      expect(screen.getByText("Doomed")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Delete"));
    expect(screen.getByTestId("confirm-dialog")).toBeDefined();
    expect(deleteStockListMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete list" }));

    await waitFor(() => {
      expect(deleteStockListMock).toHaveBeenCalledWith("list-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("Doomed")).toBeNull();
    });
  });
});
