import type {
  StockListDetailResponse,
  StockListSummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chooseFromOverflowMenu,
  findOverflowTrigger,
} from "../../../components/ui/__testing__/overflow-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementRefusal } from "../../../lib/api/__testing__/request-failures";
import {
  guestSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import {
  createStockList,
  deleteStockList,
  duplicateStockList,
  fetchStockLists,
  updateStockList,
} from "../api/stock-lists-api";
import { ListsPage } from "./ListsPage";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  // The page reads `?view=` to choose between its three collections; the default view is the stock
  // lists this suite is about.
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
  createStockList: vi.fn(),
  updateStockList: vi.fn(),
  deleteStockList: vi.fn(),
  duplicateStockList: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
const fetchStockListsMock = vi.mocked(fetchStockLists);
const createStockListMock = vi.mocked(createStockList);
const updateStockListMock = vi.mocked(updateStockList);
const deleteStockListMock = vi.mocked(deleteStockList);
const duplicateStockListMock = vi.mocked(duplicateStockList);

/** The actions one row's menu offers, in order. Leaves the menu open. */
async function menuActions(entityName: string, scope?: HTMLElement) {
  const trigger = await findOverflowTrigger(entityName, scope);
  await userEvent.click(trigger);
  const popup = document.getElementById(
    trigger.getAttribute("aria-controls") ?? "",
  );
  return within(popup as HTMLElement)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

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
    // A built-in is read-only for a customer: its row menu can copy it, and change nothing.
    expect(await menuActions("Recent Market Debuts", builtIns)).toEqual([
      "Duplicate",
    ]);
  });

  it("opens the create dialog when another surface links to /lists?new=1 (UI-009)", async () => {
    window.history.replaceState(null, "", "/lists?new=1");
    fetchStockListsMock.mockResolvedValue([]);

    render(<ListsPage />);

    expect(await screen.findByTestId("list-form-dialog")).toBeDefined();
    // The request is consumed, so a reload lands on the plain collection.
    expect(replace).toHaveBeenCalledWith("/lists");
    window.history.replaceState(null, "", "/lists");
  });

  it("asks a Guest for an account instead of sending them to the login page", async () => {
    // The prompt carries the page being read, so signing in comes back to it (UX-003).
    window.history.replaceState(null, "", "/lists");
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
    ).toBe("/login?next=%2Flists");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register?next=%2Flists");
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

  describe("Duplicate", () => {
    const builtIn = summary("builtin-1", "S&P 500 Growth Leaders", {
      ownership: "SYSTEM",
      systemKey: "sp500-growth-leaders",
      canEdit: false,
      itemCount: 10,
    });

    it("sits between Rename and Delete in a list's menu, and nowhere as a visible button", async () => {
      fetchStockListsMock.mockResolvedValue([
        summary("list-1", "Dividend picks"),
        builtIn,
      ]);
      render(<ListsPage />);
      await screen.findByText("Dividend picks");

      // Every row keeps its one visible action; copying is a menu action like Rename.
      expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
      expect(await menuActions("Dividend picks")).toEqual([
        "Rename",
        "Duplicate",
        "Delete",
      ]);
    });

    it("copies the viewer's own list under the name they give it, then opens the copy", async () => {
      fetchStockListsMock.mockResolvedValue([
        summary("list-1", "Dividend picks"),
      ]);
      duplicateStockListMock.mockResolvedValue(detail("copy-1", "My copy"));
      render(<ListsPage />);
      await screen.findByText("Dividend picks");

      await chooseFromOverflowMenu(userEvent, "Dividend picks", "Duplicate");
      const dialog = screen.getByTestId("duplicate-dialog");
      expect(
        within(dialog).getByRole("heading", { name: "Duplicate list" }),
      ).toBeDefined();
      const name = within(dialog).getByLabelText("Name");
      expect((name as HTMLInputElement).value).toBe("Dividend picks — Copy");

      await userEvent.clear(name);
      await userEvent.type(name, "My copy");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Duplicate" }),
      );

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith("/lists/copy-1");
      });
      expect(duplicateStockListMock).toHaveBeenCalledWith("list-1", {
        name: "My copy",
      });
      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
    });

    it("lets a signed-in customer copy a built-in list, which offers nothing else", async () => {
      fetchStockListsMock.mockResolvedValue([builtIn]);
      duplicateStockListMock.mockResolvedValue(
        detail("copy-2", "S&P 500 Growth Leaders — Copy"),
      );
      render(<ListsPage />);
      const builtIns = await screen.findByTestId("built-in-lists");

      expect(await menuActions("S&P 500 Growth Leaders", builtIns)).toEqual([
        "Duplicate",
      ]);
      await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
      await userEvent.click(
        within(screen.getByTestId("duplicate-dialog")).getByRole("button", {
          name: "Duplicate",
        }),
      );

      await waitFor(() => {
        expect(push).toHaveBeenCalledWith("/lists/copy-2");
      });
      expect(duplicateStockListMock).toHaveBeenCalledWith("builtin-1", {
        name: "S&P 500 Growth Leaders — Copy",
      });
    });

    it("creates nothing when the dialog is cancelled", async () => {
      fetchStockListsMock.mockResolvedValue([
        summary("list-1", "Dividend picks"),
      ]);
      render(<ListsPage />);
      await screen.findByText("Dividend picks");

      await chooseFromOverflowMenu(userEvent, "Dividend picks", "Duplicate");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
      expect(duplicateStockListMock).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("keeps the dialog open with the API's reason when the plan refuses the copy", async () => {
      fetchStockListsMock.mockResolvedValue([builtIn]);
      duplicateStockListMock.mockRejectedValue(
        entitlementRefusal(
          "ENTITLEMENT_LIST_SYMBOL_LIMIT",
          "Your plan allows 5 stocks per list; this change would make 10",
        ),
      );
      render(<ListsPage />);
      await screen.findByTestId("built-in-lists");

      await chooseFromOverflowMenu(
        userEvent,
        "S&P 500 Growth Leaders",
        "Duplicate",
      );
      await userEvent.click(
        within(screen.getByTestId("duplicate-dialog")).getByRole("button", {
          name: "Duplicate",
        }),
      );

      expect(
        await screen.findByText(
          "Your plan allows 5 stocks per list; this change would make 10",
        ),
      ).toBeDefined();
      expect(screen.getByTestId("duplicate-dialog")).toBeDefined();
      expect(push).not.toHaveBeenCalled();
    });

    it("asks a Guest for an account instead of copying a built-in list", async () => {
      window.history.replaceState(null, "", "/lists");
      useAuthSessionMock.mockReturnValue(guestSession());
      fetchStockListsMock.mockResolvedValue([builtIn]);
      render(<ListsPage />);
      await screen.findByTestId("built-in-lists");

      await chooseFromOverflowMenu(
        userEvent,
        "S&P 500 Growth Leaders",
        "Duplicate",
      );

      const prompt = await screen.findByTestId("sign-in-prompt");
      expect(
        within(prompt).getByRole("heading", {
          name: "Sign in to duplicate a list",
        }),
      ).toBeDefined();
      expect(
        within(prompt)
          .getByRole("link", { name: "Sign in" })
          .getAttribute("href"),
      ).toBe("/login?next=%2Flists");
      expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
      expect(duplicateStockListMock).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
  });
});
