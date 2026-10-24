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
  fetchHistoricalUniverses,
  fetchStockLists,
  updateStockList,
} from "../api/stock-lists-api";
import { ListsPage } from "./ListsPage";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
  fetchHistoricalUniverses: vi.fn(),
  createStockList: vi.fn(),
  updateStockList: vi.fn(),
  deleteStockList: vi.fn(),
  duplicateStockList: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
const fetchStockListsMock = vi.mocked(fetchStockLists);
const fetchHistoricalUniversesMock = vi.mocked(fetchHistoricalUniverses);
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
  fetchHistoricalUniversesMock.mockResolvedValue({ categories: [] });
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

  it("is stock lists and nothing else: there is no Congress groups view", async () => {
    fetchStockListsMock.mockResolvedValue([
      summary("list-1", "Dividend picks", { itemCount: 3 }),
    ]);

    render(<ListsPage />);

    await screen.findByTestId("your-lists");
    expect(screen.queryByTestId("lists-view")).toBeNull();
    expect(screen.queryByRole("radio", { name: /congress/i })).toBeNull();
    expect(screen.queryByText(/congress/i)).toBeNull();
    expect(
      screen.getByText(
        "Reusable stock universes for strategies, backtests, and monitors.",
      ),
    ).toBeDefined();
  });

  it("shows the stock lists for an old /lists?view=congress link, and drops the dead parameter", async () => {
    window.history.replaceState(null, "", "/lists?view=congress");
    fetchStockListsMock.mockResolvedValue([
      summary("list-1", "Dividend picks", { itemCount: 3 }),
    ]);

    render(<ListsPage />);

    const own = await screen.findByTestId("your-lists");
    expect(own.textContent).toContain("Dividend picks");
    expect(screen.getAllByTestId("new-list-button")).toHaveLength(1);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/lists"));
    // It is a landing, not a request: no dialog opens.
    expect(screen.queryByRole("dialog")).toBeNull();
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

describe("ListsPage premium built-ins", () => {
  const standard = summary("builtin-standard", "Recent Market Debuts", {
    ownership: "SYSTEM",
    systemKey: "recent-market-debuts",
    canEdit: false,
    itemCount: 10,
  });
  /** A premium predefined List, as the API sends it to a plan without premium content. */
  const lockedPremium = summary("quality-leaders", "Quality Leaders", {
    ownership: "SYSTEM",
    systemKey: "quality-leaders",
    canEdit: false,
    premium: true,
    locked: true,
    itemCount: 40,
  });

  it("names a locked premium list, marks it locked, and says which plans include it", async () => {
    useAuthSessionMock.mockReturnValue(signedInSession({ plan: "STARTER" }));
    fetchStockListsMock.mockResolvedValue([standard, lockedPremium]);
    render(<ListsPage />);

    const section = await screen.findByTestId("built-in-lists");
    const badges = within(section).getAllByTestId("premium-badge");
    // Only the premium list carries the badge; the standard built-in reads as before.
    expect(badges).toHaveLength(1);
    const badge = badges[0] as HTMLElement;
    expect(badge.getAttribute("data-locked")).toBe("true");
    expect(badge.getAttribute("data-tone")).toBe("blocked");
    expect(badge.textContent).toBe("Premium, locked");
    expect(section.textContent).toContain("Quality Leaders");
    const hint = within(section).getByTestId("premium-upgrade-hint");
    expect(hint.textContent).toBe("Included in Pro and Pro+. See plans");
    expect(
      within(hint)
        .getByRole("link", { name: "See plans" })
        .getAttribute("href"),
    ).toBe("/pricing");
    // The caption no longer claims everyone can backtest every built-in.
    expect(section.textContent).toContain(
      "premium lists are included in Pro and Pro+",
    );
  });

  it("offers no copy of a locked premium list", async () => {
    useAuthSessionMock.mockReturnValue(signedInSession({ plan: "STARTER" }));
    fetchStockListsMock.mockResolvedValue([lockedPremium]);
    render(<ListsPage />);
    await screen.findByTestId("built-in-lists");

    const trigger = await findOverflowTrigger("Quality Leaders");
    await userEvent.click(trigger);
    const popup = document.getElementById(
      trigger.getAttribute("aria-controls") ?? "",
    ) as HTMLElement;
    const duplicate = within(popup).getByRole("button", { name: "Duplicate" });
    expect(duplicate.hasAttribute("disabled")).toBe(true);
    await userEvent.click(duplicate);
    expect(screen.queryByTestId("duplicate-dialog")).toBeNull();
    expect(duplicateStockListMock).not.toHaveBeenCalled();
  });

  it("marks premium without a lock where the plan includes it, and still offers the copy", async () => {
    fetchStockListsMock.mockResolvedValue([
      { ...lockedPremium, locked: undefined },
    ]);
    render(<ListsPage />);

    const section = await screen.findByTestId("built-in-lists");
    const badge = within(section).getByTestId("premium-badge");
    expect(badge.textContent).toBe("Premium");
    expect(badge.getAttribute("data-locked")).toBeNull();
    expect(within(section).queryByTestId("premium-upgrade-hint")).toBeNull();
    expect(await menuActions("Quality Leaders")).toEqual(["Duplicate"]);
  });
});

describe("ListsPage historical universes", () => {
  const sp500 = summary("sp500-pit", "S&P 500 — Historical PIT", {
    ownership: "SYSTEM",
    systemKey: "sp500-historical-pit",
    canEdit: false,
    premium: true,
    itemCount: 731,
    universe: {
      kind: "POINT_IN_TIME_INDEX",
      indexKey: "SP500",
      universeKey: "sp500-historical-pit",
      category: "MARKET_INDICES",
      derived: false,
      distinctSecurities: 731,
      peakSimultaneousMembers: 506,
      currentMembers: 503,
      membershipFloor: "1996-01-02",
      syncedAt: "2026-10-17T10:00:00.000Z",
    },
  });
  const catalog = (locked: boolean) => ({
    categories: [
      {
        key: "MARKET_INDICES",
        label: "Market Indices",
        universes: [
          {
            key: "sp500-historical-pit",
            name: "S&P 500 — Historical PIT",
            description: "Every S&P 500 constituent since 1996.",
            premium: true as const,
            locked,
            availability: "AVAILABLE" as const,
            listId: "sp500-pit",
            availableFrom: "1996-01-02",
            unavailableReason: null,
          },
        ],
      },
      {
        key: "SP500_SECTORS",
        label: "S&P 500 Sectors",
        universes: [
          {
            key: "sp500-sector-energy",
            name: "S&P 500 Energy",
            description: "The S&P 500's Energy sector members on each date.",
            premium: true as const,
            locked,
            availability: "UNAVAILABLE" as const,
            listId: null,
            availableFrom: null,
            unavailableReason:
              "Historical data unavailable: no point-in-time sector classification is available for past members, and today's sectors are never applied to the past.",
          },
        ],
      },
      { key: "DOW_STRATEGIES", label: "Dow Strategies", universes: [] },
    ],
  });

  it("groups the universes by category, with a locked Pro label where the plan lacks it", async () => {
    useAuthSessionMock.mockReturnValue(signedInSession({ plan: "STARTER" }));
    fetchStockListsMock.mockResolvedValue([sp500]);
    fetchHistoricalUniversesMock.mockResolvedValue(catalog(true));
    render(<ListsPage />);

    const universes = await screen.findByTestId("historical-universes");
    expect(within(universes).getByTestId("historical-universes-MARKET_INDICES").textContent).toContain(
      "Market Indices",
    );
    // An empty category is not shown.
    expect(within(universes).queryByTestId("historical-universes-DOW_STRATEGIES")).toBeNull();
    const rows = within(universes).getAllByTestId("historical-universe");
    const [available, sector] = rows as [HTMLElement, HTMLElement];

    // Requires Pro: a lock and "Pro", the size, and the way to the plans.
    const badge = within(available).getByTestId("universe-pro-badge");
    expect(badge.textContent).toBe("Pro, locked");
    expect(
      within(available).getByRole("link", { name: /S&P 500 — Historical PIT/ }).getAttribute("href"),
    ).toBe("/lists/sp500-pit");
    expect(within(available).getByTestId("universe-size").textContent).toContain(
      "Point-in-time from 1996 · 731 stocks over time, up to 506 at once",
    );
    expect(within(available).getByTestId("universe-requires-pro").textContent).toContain(
      "Requires Pro.",
    );
    expect(within(available).getByTestId("premium-upgrade-hint")).toBeTruthy();

    // Historical data unavailable: said in words, no link, and no plan pitch — no plan unlocks it.
    expect(within(sector).getByTestId("universe-unavailable").textContent).toBe(
      "Historical data unavailable",
    );
    expect(within(sector).getByTestId("universe-unavailable-reason").textContent).toContain(
      "today's sectors are never applied to the past",
    );
    expect(within(sector).queryByRole("link")).toBeNull();
    expect(within(sector).queryByTestId("premium-upgrade-hint")).toBeNull();
    expect(within(sector).queryByTestId("universe-requires-pro")).toBeNull();
  });

  it("shows the Pro label unlocked on a plan that includes it", async () => {
    fetchStockListsMock.mockResolvedValue([sp500]);
    fetchHistoricalUniversesMock.mockResolvedValue(catalog(false));
    render(<ListsPage />);

    const universes = await screen.findByTestId("historical-universes");
    const badge = within(universes).getAllByTestId("universe-pro-badge")[0] as HTMLElement;
    expect(badge.textContent).toBe("Pro");
    expect(within(universes).queryByTestId("premium-upgrade-hint")).toBeNull();
  });

  it("keeps a maintained universe out of the copyable built-ins", async () => {
    fetchStockListsMock.mockResolvedValue([
      sp500,
      summary("builtin-standard", "Recent Market Debuts", {
        ownership: "SYSTEM",
        systemKey: "recent-market-debuts",
        canEdit: false,
        itemCount: 10,
      }),
    ]);
    fetchHistoricalUniversesMock.mockResolvedValue(catalog(false));
    render(<ListsPage />);

    const builtIns = await screen.findByTestId("built-in-lists");
    expect(builtIns.textContent).not.toContain("S&P 500 — Historical PIT");
    expect(builtIns.textContent).toContain("Recent Market Debuts");
  });
});
