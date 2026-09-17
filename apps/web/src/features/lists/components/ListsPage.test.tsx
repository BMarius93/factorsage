import type {
  StockListDetailResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chooseFromOverflowMenu } from "../../../components/ui/__testing__/overflow-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
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

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
  createStockList: vi.fn(),
  updateStockList: vi.fn(),
  deleteStockList: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
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
    ownership: "USER",
    canEdit: true,
    id,
    name,
    itemCount: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    compliance: { symbolCount: 0, symbolLimit: 100, compliant: true },
    ...overrides,
  };
}

function detail(id: string, name: string): StockListDetailResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id,
    name,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    items: [],
    compliance: { symbolCount: 0, symbolLimit: 100, compliant: true },
  };
}

beforeEach(() => {
  push.mockReset();
  useAuthSessionMock.mockReturnValue(signedInSession());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ListsPage", () => {
  it("keeps an empty 'Your lists' compact so the built-ins under it still show", async () => {
    fetchStockListsMock.mockResolvedValue([
      summary("builtin-1", "S&P 500 Growth Leaders", {
        ownership: "SYSTEM",
        systemKey: "sp500-growth-leaders",
        canEdit: false,
        itemCount: 10,
      }),
    ]);

    render(<ListsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("lists-empty")).toBeDefined();
    });
    expect(screen.getByText("You haven't created any lists yet")).toBeDefined();
    // The built-in section is a peer of the empty one, not something it replaced.
    const builtIns = screen.getByTestId("built-in-lists");
    expect(builtIns.textContent).toContain("S&P 500 Growth Leaders");
    expect(screen.getAllByTestId("new-list-button")).toHaveLength(1);
  });

  it("separates the viewer's own lists from the built-in ones", async () => {
    fetchStockListsMock.mockResolvedValue([
      summary("builtin-1", "Recent Market Debuts", {
        ownership: "SYSTEM",
        systemKey: "recent-market-debuts",
        canEdit: false,
        itemCount: 10,
      }),
      summary("list-1", "Dividend picks", { itemCount: 3 }),
    ]);

    render(<ListsPage />);

    const own = await screen.findByTestId("your-lists");
    const builtIns = screen.getByTestId("built-in-lists");
    expect(own.textContent).toContain("Dividend picks");
    expect(own.textContent).not.toContain("Recent Market Debuts");
    expect(builtIns.textContent).toContain("Recent Market Debuts");
    expect(builtIns.textContent).not.toContain("Dividend picks");
    // Your content first.
    expect(own.compareDocumentPosition(builtIns)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // A built-in is read-only for a customer: no row menu at all.
    expect(
      within(builtIns).queryByRole("button", { name: /Recent Market Debuts/ }),
    ).toBeNull();
  });

  it("asks a Guest for an account instead of sending them to the login page", async () => {
    useAuthSessionMock.mockReturnValue(guestSession());
    fetchStockListsMock.mockResolvedValue([
      summary("builtin-1", "Nasdaq-100 Newcomers", {
        ownership: "SYSTEM",
        systemKey: "nasdaq100-newcomers",
        canEdit: false,
        itemCount: 10,
      }),
    ]);

    render(<ListsPage />);

    expect(await screen.findByTestId("built-in-lists")).toBeDefined();
    // No fake "Your lists" section for someone who cannot own one.
    expect(screen.queryByTestId("your-lists")).toBeNull();

    await userEvent.click(screen.getByTestId("new-list-button"));
    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register");
    // They are still on the page they were reading, and nothing was created.
    expect(screen.getByTestId("lists-page")).toBeDefined();
    expect(push).not.toHaveBeenCalled();
    expect(createStockListMock).not.toHaveBeenCalled();
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
      expect(screen.getByText("Your lists could not be loaded")).toBeDefined();
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

    await userEvent.click(screen.getByTestId("new-list-button"));
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

    await userEvent.click(screen.getByTestId("new-list-button"));
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

    await chooseFromOverflowMenu(userEvent, "Old name", "Rename");
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

    await chooseFromOverflowMenu(userEvent, "Doomed", "Delete");
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
