import type {
  MonitorDetailResponse,
  MonitorSummaryResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chooseFromOverflowMenu,
  openOverflowMenu,
} from "../../../components/ui/__testing__/overflow-menu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  guestSession,
  signedInSession,
} from "../../auth/__testing__/auth-session";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import {
  createMonitor,
  deleteMonitor,
  fetchMonitors,
  setBuiltInMonitorVisibility,
  updateMonitor,
} from "../api/monitors-api";
import { MonitorsPage } from "./MonitorsPage";
import { blockedExplanation } from "../utils/blocked-status";

/**
 * Between 880 and 1,279px the Strategy and Stock list columns fold under the monitor's name
 * (UI-01). jsdom applies no stylesheet, so both copies exist here; assertions about the columns
 * look past the folded one.
 */
const OUTSIDE_FOLD = {
  ignore: 'script, style, [data-testid="monitor-folded-relationships"] *',
};

vi.mock("../api/monitors-api", () => ({
  fetchMonitors: vi.fn(),
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  deleteMonitor: vi.fn(),
  setBuiltInMonitorVisibility: vi.fn(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const useAuthSessionMock = vi.mocked(useAuthSession);
const fetchMonitorsMock = vi.mocked(fetchMonitors);
const setVisibilityMock = vi.mocked(setBuiltInMonitorVisibility);
const createMonitorMock = vi.mocked(createMonitor);
const updateMonitorMock = vi.mocked(updateMonitor);
const deleteMonitorMock = vi.mocked(deleteMonitor);
const fetchStrategiesMock = vi.mocked(fetchStrategies);
const fetchStockListsMock = vi.mocked(fetchStockLists);

const STRATEGIES: StrategySummaryResponse[] = [
  {
    ownership: "USER",
    canEdit: true,
    id: "strategy-1",
    name: "Deep value",
    buyLevelCount: 2,
    sellLevelCount: 1,
    hasFinalExit: true,
    versionNumber: 3,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  {
    ownership: "USER",
    canEdit: true,
    id: "strategy-2",
    name: "Momentum exits",
    buyLevelCount: 1,
    sellLevelCount: 2,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];

const LISTS: StockListSummaryResponse[] = [
  {
    ownership: "USER",
    canEdit: true,
    id: "list-1",
    name: "Quality compounders",
    itemCount: 12,
    compliance: { symbolCount: 12, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  {
    ownership: "USER",
    canEdit: true,
    id: "list-2",
    name: "Tech universe",
    itemCount: 5,
    compliance: { symbolCount: 5, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];

function summary(
  overrides: Partial<MonitorSummaryResponse> = {},
): MonitorSummaryResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id: "monitor-1",
    name: "Value entries",
    enabled: true,
    strategyId: "strategy-1",
    strategyName: "Deep value",
    stockListId: "list-1",
    stockListName: "Quality compounders",
    securityCount: 12,
    activeSignalCount: 0,
    operationalStatus: "ACTIVE" as const,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function detail(
  overrides: Partial<MonitorSummaryResponse> = {},
): MonitorDetailResponse {
  return { ...summary(overrides), securities: [], signals: [] };
}

async function openCreateDialog() {
  await userEvent.click(await screen.findByTestId("new-monitor-button"));
  await waitFor(() => {
    expect(screen.getByTestId("monitor-form")).toBeDefined();
  });
}

beforeEach(() => {
  fetchMonitorsMock.mockReset();
  createMonitorMock.mockReset();
  updateMonitorMock.mockReset();
  deleteMonitorMock.mockReset();
  setVisibilityMock.mockReset();
  fetchStrategiesMock.mockReset().mockResolvedValue(STRATEGIES);
  fetchStockListsMock.mockReset().mockResolvedValue(LISTS);
  useAuthSessionMock.mockReturnValue(signedInSession());
});

/** A published built-in, as `GET /monitors` reports one to a signed-in customer. */
function builtIn(
  overrides: Partial<MonitorSummaryResponse> = {},
): MonitorSummaryResponse {
  return summary({
    ownership: "SYSTEM",
    systemKey: "sp500-value-and-trend",
    canEdit: false,
    id: "builtin-1",
    name: "S&P Value & Trend",
    strategyId: "strategy-b",
    strategyName: "Value & Trend",
    stockListId: "list-b",
    stockListName: "S&P 500 Growth Leaders",
    isPublished: true,
    isGloballyEnabled: true,
    dashboardVisible: true,
    ...overrides,
  });
}

describe("MonitorsPage", () => {
  it("shows the empty state with a create call to action", async () => {
    fetchMonitorsMock.mockResolvedValue([]);

    render(<MonitorsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("monitors-empty")).toBeDefined();
    });
    expect(
      screen.getByText("You haven't created any monitors yet"),
    ).toBeDefined();
    expect(screen.queryByTestId("monitors-grid")).toBeNull();
  });

  it("keeps an empty 'Your monitors' compact so the built-ins under it still show", async () => {
    fetchMonitorsMock.mockResolvedValue([builtIn()]);

    render(<MonitorsPage />);

    expect(await screen.findByTestId("monitors-empty")).toBeDefined();
    const builtIns = screen.getByTestId("built-in-monitors");
    expect(builtIns.textContent).toContain("S&P Value & Trend");
    expect(screen.getAllByTestId("new-monitor-button")).toHaveLength(1);
  });

  it("separates the viewer's own monitors from the built-in ones", async () => {
    fetchMonitorsMock.mockResolvedValue([builtIn(), summary()]);

    render(<MonitorsPage />);

    const own = await screen.findByTestId("your-monitors");
    const builtIns = screen.getByTestId("built-in-monitors");
    expect(own.textContent).toContain("Value entries");
    expect(own.textContent).not.toContain("S&P Value & Trend");
    expect(builtIns.textContent).toContain("S&P Value & Trend");
    // Your content first.
    expect(own.compareDocumentPosition(builtIns)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // A built-in is read-only for a customer: no enable/disable, no edit, no delete.
    expect(
      within(builtIns).queryByRole("button", { name: /S&P Value & Trend/ }),
    ).toBeNull();
    expect(
      within(builtIns).getByRole("link", { name: /^Open / }).getAttribute("href"),
    ).toBe("/monitors/builtin-1");
  });

  it("saves a built-in's dashboard visibility as this user's own preference", async () => {
    const user = userEvent.setup();
    // The page re-reads the collection after a change, so the second answer is the persisted
    // preference: the row never keeps a value the server did not confirm.
    fetchMonitorsMock
      .mockResolvedValueOnce([builtIn()])
      .mockResolvedValue([builtIn({ dashboardVisible: false })]);
    setVisibilityMock.mockResolvedValue(undefined);

    render(<MonitorsPage />);

    const toggle = await screen.findByTestId("built-in-monitor-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);

    await waitFor(() =>
      expect(setVisibilityMock).toHaveBeenCalledWith("builtin-1", {
        visible: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("built-in-monitor-toggle").getAttribute("aria-checked"),
      ).toBe("false"),
    );
    // It is a preference, never the shared monitor: nothing patched the monitor itself.
    expect(updateMonitorMock).not.toHaveBeenCalled();
  });

  it("keeps the row on its real preference when the change is refused", async () => {
    const user = userEvent.setup();
    fetchMonitorsMock.mockResolvedValue([builtIn()]);
    setVisibilityMock.mockRejectedValue(new Error("network"));

    render(<MonitorsPage />);
    await user.click(await screen.findByTestId("built-in-monitor-toggle"));

    expect(
      await screen.findByTestId("monitor-visibility-error"),
    ).toBeDefined();
    expect(
      screen.getByTestId("built-in-monitor-toggle").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows a hidden built-in as hidden", async () => {
    fetchMonitorsMock.mockResolvedValue([builtIn({ dashboardVisible: false })]);

    render(<MonitorsPage />);

    expect(
      (await screen.findByTestId("built-in-monitor-toggle")).getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });

  it("lets an administrator edit a built-in through the ordinary editor", async () => {
    fetchMonitorsMock.mockResolvedValue([builtIn({ canEdit: true })]);
    useAuthSessionMock.mockReturnValue(signedInSession({ role: "ADMIN" }));

    render(<MonitorsPage />);
    await screen.findByTestId("built-in-monitors");

    await chooseFromOverflowMenu(userEvent, "S&P Value & Trend", "Edit");
    await waitFor(() => expect(screen.getByTestId("monitor-form")).toBeDefined());
    // Deleting a built-in is offered to nobody.
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("asks a Guest for an account rather than storing a preference or redirecting", async () => {
    // The prompt carries the page being read, so signing in comes back to it (UX-003).
    window.history.replaceState(null, "", "/monitors");
    const user = userEvent.setup();
    useAuthSessionMock.mockReturnValue(guestSession());
    fetchMonitorsMock.mockResolvedValue([builtIn()]);

    render(<MonitorsPage />);

    expect(await screen.findByTestId("built-in-monitors")).toBeDefined();
    expect(screen.queryByTestId("your-monitors")).toBeNull();

    await user.click(screen.getByTestId("built-in-monitor-toggle"));
    let prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?next=%2Fmonitors");
    expect(setVisibilityMock).not.toHaveBeenCalled();
    await user.click(within(prompt).getByRole("button", { name: "Close dialog" }));

    await user.click(screen.getByTestId("new-monitor-button"));
    prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register?next=%2Fmonitors");
    expect(screen.queryByTestId("monitor-form")).toBeNull();
    // Still on the monitors page throughout.
    expect(screen.getByTestId("monitors-page")).toBeDefined();
  });

  it("identifies each monitor by its strategy, list, universe and state", async () => {
    fetchMonitorsMock.mockResolvedValue([
      summary({ activeSignalCount: 3, lastScanAt: "2026-09-12T09:30:00.000Z" }),
      summary({
        id: "monitor-2",
        name: "Exit watch",
        enabled: false,
        strategyName: "Momentum exits",
        stockListName: "Tech universe",
        securityCount: 1,
      }),
    ]);

    render(<MonitorsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("monitors-grid")).toBeDefined();
    });
    expect(screen.getAllByTestId("monitor-card")).toHaveLength(2);

    expect(screen.getByText("Value entries")).toBeDefined();
    expect(screen.getByText("Deep value", OUTSIDE_FOLD)).toBeDefined();
    expect(screen.getByText("Quality compounders", OUTSIDE_FOLD)).toBeDefined();
    expect(screen.getByText("12 stocks", OUTSIDE_FOLD)).toBeDefined();
    expect(screen.getByText("3 active signals")).toBeDefined();
    expect(screen.getByText(/^Sep 12, 2026, /)).toBeDefined();

    expect(screen.getByText("Enabled")).toBeDefined();
    expect(screen.getByText("Disabled")).toBeDefined();
    // A monitor that has never been included in a cycle says so rather than borrowing a timestamp.
    expect(screen.getByText("Not checked yet")).toBeDefined();
    expect(screen.getByText("1 stock", OUTSIDE_FOLD)).toBeDefined();

    // The strategy and the list a monitor references stay reachable from the row.
    expect(
      screen.getAllByRole("link", { name: "Deep value" })[0]!.getAttribute("href"),
    ).toBe("/strategies/strategy-1");
    expect(
      screen
        .getAllByRole("link", { name: "Quality compounders" })[0]!
        .getAttribute("href"),
    ).toBe("/lists/list-1");
  });

  it("shows the effective scanning state beside the configured one (UX-004)", async () => {
    fetchMonitorsMock.mockResolvedValue([
      summary({
        operationalStatus: "BLOCKED_BY_ENTITLEMENT",
        blockedReason: "MONITOR_CAPACITY",
      }),
      summary({
        id: "monitor-2",
        name: "Exit watch",
        operationalStatus: "BLOCKED_BY_ENTITLEMENT",
        blockedReason: "LIST_OVER_LIMIT",
      }),
      summary({ id: "monitor-3", name: "Scanning fine" }),
    ]);

    render(<MonitorsPage />);

    const pills = await screen.findAllByTestId("monitor-blocked-pill");
    expect(pills).toHaveLength(2);
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "Not scanning",
      "Not scanning",
    ]);
    expect(pills.map((pill) => pill.getAttribute("title"))).toEqual([
      blockedExplanation("MONITOR_CAPACITY"),
      blockedExplanation("LIST_OVER_LIMIT"),
    ]);
    // Still enabled: the configured switch is never rewritten by the operational state.
    expect(screen.getAllByTestId("monitor-enabled-pill")).toHaveLength(3);
  });

  it("reports a load failure and recovers through retry", async () => {
    fetchMonitorsMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([summary({ name: "Recovered" })]);

    render(<MonitorsPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Your monitors could not be loaded"),
      ).toBeDefined();
    });

    await userEvent.click(screen.getByText("Try again"));

    await waitFor(() => {
      expect(screen.getByText("Recovered")).toBeDefined();
    });
  });

  it("creates a monitor from the dialog and shows it in the collection", async () => {
    // Empty first, then holding the new monitor: the page re-reads the collection after a
    // mutation, because a monitor's operational status depends on the whole set rather than on
    // its own row.
    fetchMonitorsMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        summary({ id: "monitor-new", name: "Value entries" }),
      ]);
    createMonitorMock.mockResolvedValue(
      detail({ id: "monitor-new", name: "Value entries" }),
    );

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("monitors-empty")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("new-monitor-button"));
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });

    await userEvent.type(screen.getByLabelText("Name"), "Value entries");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Stock list"),
      "list-1",
    );
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(createMonitorMock).toHaveBeenCalledWith({
        name: "Value entries",
        strategyId: "strategy-1",
        stockListId: "list-1",
        enabled: true,
      });
    });

    // The new monitor appears immediately from the API's own answer, and the collection is then
    // re-read so every *other* card shows the status the server now holds: creating a monitor can
    // push a sibling past the plan's active capacity.
    await waitFor(() => {
      expect(screen.getByTestId("monitors-grid")).toBeDefined();
    });
    expect(screen.getByText("Value entries")).toBeDefined();
    expect(screen.queryByTestId("monitor-form-dialog")).toBeNull();
    await waitFor(() => {
      expect(fetchMonitorsMock).toHaveBeenCalledTimes(2);
    });
  });

  it("disables a monitor and adopts the state the API answered with", async () => {
    fetchMonitorsMock
      .mockResolvedValueOnce([summary()])
      .mockResolvedValue([summary({ enabled: false })]);
    updateMonitorMock.mockResolvedValue(summary({ enabled: false }));

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Enabled")).toBeDefined();
    });

    await openOverflowMenu(userEvent, "Value entries");
    await userEvent.click(screen.getByTestId("toggle-monitor"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeDefined();
    });
    expect(screen.queryByText("Enabled")).toBeNull();
    // The action now offers the opposite transition.
    await openOverflowMenu(userEvent, "Value entries");
    expect(screen.getByTestId("toggle-monitor").textContent).toBe("Enable");
  });

  it("re-enables a disabled monitor", async () => {
    fetchMonitorsMock
      .mockResolvedValueOnce([summary({ enabled: false })])
      .mockResolvedValue([summary({ enabled: true })]);
    updateMonitorMock.mockResolvedValue(summary({ enabled: true }));

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeDefined();
    });
    await openOverflowMenu(userEvent, "Value entries");
    expect(screen.getByTestId("toggle-monitor").textContent).toBe("Enable");

    await userEvent.click(screen.getByTestId("toggle-monitor"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Enabled")).toBeDefined();
    });
  });

  it("leaves the row on its real state when the toggle fails", async () => {
    fetchMonitorsMock.mockResolvedValue([summary()]);
    updateMonitorMock.mockRejectedValue(new Error("network"));

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Enabled")).toBeDefined();
    });

    await openOverflowMenu(userEvent, "Value entries");
    await userEvent.click(screen.getByTestId("toggle-monitor"));

    await waitFor(() => {
      expect(
        screen.getByText("That change did not save. This monitor is still", {
          exact: false,
        }),
      ).toBeDefined();
    });
    // Nothing was applied optimistically, so the card still shows what the server holds.
    expect(screen.getByText("Enabled")).toBeDefined();
    await openOverflowMenu(userEvent, "Value entries");
    expect(screen.getByTestId("toggle-monitor").textContent).toBe("Disable");
    // And the action is usable again rather than stuck pending.
    expect(screen.getByTestId("toggle-monitor").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("deletes a monitor only after confirmation", async () => {
    fetchMonitorsMock
      .mockResolvedValueOnce([summary({ name: "Doomed" })])
      .mockResolvedValue([]);
    deleteMonitorMock.mockResolvedValue(undefined);

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Doomed")).toBeDefined();
    });

    await chooseFromOverflowMenu(userEvent, "Doomed", "Delete");
    expect(screen.getByTestId("confirm-dialog")).toBeDefined();
    expect(deleteMonitorMock).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete monitor" }),
    );

    await waitFor(() => {
      expect(deleteMonitorMock).toHaveBeenCalledWith("monitor-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("Doomed")).toBeNull();
    });
    expect(screen.getByTestId("monitors-empty")).toBeDefined();
  });

  it("opens a monitor's own page from its name", async () => {
    fetchMonitorsMock.mockResolvedValue([summary()]);

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("monitors-grid")).toBeDefined();
    });

    expect(
      screen.getByRole("link", { name: "Value entries" }).getAttribute("href"),
    ).toBe("/monitors/monitor-1");
  });

  it("edits a monitor from the card, prepopulated with what it watches", async () => {
    fetchMonitorsMock
      .mockResolvedValueOnce([summary({ name: "Old name" })])
      .mockResolvedValue([summary({ name: "New name" })]);
    updateMonitorMock.mockResolvedValue(summary({ name: "New name" }));

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Old name")).toBeDefined();
    });

    await chooseFromOverflowMenu(userEvent, "Old name", "Edit");
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });
    // The form arrives carrying the monitor's current configuration.
    expect(screen.getByLabelText("Strategy")).toHaveProperty(
      "value",
      "strategy-1",
    );
    expect(screen.getByLabelText("Stock list")).toHaveProperty(
      "value",
      "list-1",
    );

    const nameInput = screen.getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "New name");
    await userEvent.click(screen.getByText("Save changes"));

    // Unchanged references are still submitted; the API compares values, so this is not a rebind.
    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        name: "New name",
        strategyId: "strategy-1",
        stockListId: "list-1",
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByText("New name")).toBeDefined();
    });
    expect(screen.queryByText("Old name")).toBeNull();
  });

  it("rebinds a monitor to another strategy and list from the collection", async () => {
    const rebound = summary({
      strategyId: "strategy-2",
      strategyName: "Momentum exits",
      stockListId: "list-2",
      stockListName: "Tech universe",
      lastScanAt: undefined,
    });
    fetchMonitorsMock
      .mockResolvedValueOnce([summary()])
      .mockResolvedValue([rebound]);
    updateMonitorMock.mockResolvedValue(rebound);

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByText("Deep value", OUTSIDE_FOLD)).toBeDefined();
    });

    await chooseFromOverflowMenu(userEvent, "Value entries", "Edit");
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Stock list"),
      "list-2",
    );
    // The consequence is explained only once the selection has actually moved.
    expect(screen.getByTestId("monitor-rebind-note")).toBeDefined();
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        name: "Value entries",
        strategyId: "strategy-2",
        stockListId: "list-2",
        enabled: true,
      });
    });
    // The collection reflects the rebind, including the reset last-checked line.
    await waitFor(() => {
      expect(screen.getByText("Momentum exits", OUTSIDE_FOLD)).toBeDefined();
    });
    expect(screen.getByText("Tech universe", OUTSIDE_FOLD)).toBeDefined();
    expect(screen.getByText("Not checked yet")).toBeDefined();
  });

  it("hides the collection call to action until there is a collection", async () => {
    fetchMonitorsMock.mockResolvedValue([summary()]);

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("monitors-grid")).toBeDefined();
    });

    // Exactly one CTA: the header's. The empty state's is gone.
    expect(screen.getAllByTestId("new-monitor-button")).toHaveLength(1);
    await openCreateDialog();
    expect(screen.getByTestId("monitor-form-dialog")).toBeDefined();
  });
});
