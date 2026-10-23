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
  updateMonitor,
} from "../api/monitors-api";
import { MonitorsPage } from "./MonitorsPage";
import { blockedShortReason } from "../utils/blocked-status";

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
    ...overrides,
  });
}

/** The one Enabled / Disabled switch of the row naming `name`. */
function switchOf(name: string): HTMLElement {
  const row = screen
    .getAllByTestId("monitor-card")
    .find((card) => within(card).queryByRole("link", { name }));
  if (!row) {
    throw new Error(`No row for ${name}`);
  }
  return within(row).getByTestId("monitor-enabled-switch");
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
    // A built-in has the same switch as the customer's own monitor — their own choice for it — and
    // nothing else a customer can do to it: no edit, no delete, so its menu cell is empty.
    expect(within(builtIns).getByTestId("monitor-enabled-switch")).toBeDefined();
    expect(within(own).getByTestId("monitor-enabled-switch")).toBeDefined();
    // The row opens through its name: there is one link to the monitor, not a second "Open".
    expect(
      within(builtIns)
        .getByRole("link", { name: "S&P Value & Trend" })
        .getAttribute("href"),
    ).toBe("/monitors/builtin-1");
    expect(within(builtIns).queryByRole("link", { name: /^Open / })).toBeNull();
    expect(
      within(builtIns).queryByRole("button", { name: /More actions/ }),
    ).toBeNull();
    // One table shape for both sections, and no separate dashboard column.
    const headers = (section: HTMLElement) =>
      within(section)
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim());
    expect(headers(builtIns)).toEqual(headers(own));
    expect(headers(own)).toEqual([
      "Monitor",
      "Enabled",
      "Strategy",
      "Stock list",
      "Active signals",
      "Last checked",
      "Actions",
    ]);
    expect(screen.queryByText(/on my dashboard/i)).toBeNull();
  });

  it("enables or disables a built-in for this viewer alone, through the same switch", async () => {
    const user = userEvent.setup();
    // The page re-reads the collection after a change, so the second answer is the persisted
    // choice: the row never keeps a value the server did not confirm.
    fetchMonitorsMock
      .mockResolvedValueOnce([builtIn()])
      .mockResolvedValue([builtIn({ enabled: false })]);
    updateMonitorMock.mockResolvedValue(builtIn({ enabled: false }));

    render(<MonitorsPage />);

    const toggle = await screen.findByTestId("monitor-enabled-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);

    await waitFor(() =>
      expect(updateMonitorMock).toHaveBeenCalledWith("builtin-1", {
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("monitor-enabled-switch").getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      screen.getByTestId("monitor-enabled-control").getAttribute("data-enabled"),
    ).toBe("false");
  });

  it("keeps the row on its real state when the change is refused", async () => {
    const user = userEvent.setup();
    fetchMonitorsMock.mockResolvedValue([builtIn()]);
    updateMonitorMock.mockRejectedValue(new Error("network"));

    render(<MonitorsPage />);
    await user.click(await screen.findByTestId("monitor-enabled-switch"));

    expect(await screen.findByTestId("monitor-toggle-error")).toBeDefined();
    expect(
      screen.getByTestId("monitor-enabled-switch").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows a built-in the viewer disabled as disabled, and one FactorSage paused as paused", async () => {
    fetchMonitorsMock.mockResolvedValue([
      builtIn({ enabled: false }),
      builtIn({
        id: "builtin-2",
        name: "Paused built-in",
        isGloballyEnabled: false,
        operationalStatus: "DISABLED",
      }),
    ]);

    render(<MonitorsPage />);

    expect(
      (await screen.findAllByTestId("monitor-enabled-switch")).map((toggle) =>
        toggle.getAttribute("aria-checked"),
      ),
    ).toEqual(["false", "true"]);
    // Enabled by the viewer, but not evaluating: never presented as running.
    expect(
      screen.getAllByTestId("monitor-state-pill").map((pill) => pill.textContent),
    ).toEqual(["Paused by FactorSage"]);
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

    await user.click(screen.getByTestId("monitor-enabled-switch"));
    let prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?next=%2Fmonitors");
    expect(updateMonitorMock).not.toHaveBeenCalled();
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

    expect(switchOf("Value entries").getAttribute("aria-checked")).toBe("true");
    expect(switchOf("Exit watch").getAttribute("aria-checked")).toBe("false");
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
    // Newest first, as the API and the default order both put them.
    fetchMonitorsMock.mockResolvedValue([
      summary({
        operationalStatus: "BLOCKED_BY_ENTITLEMENT",
        blockedReason: "MONITOR_CAPACITY",
        createdAt: "2026-09-03T10:00:00.000Z",
      }),
      summary({
        id: "monitor-2",
        name: "Exit watch",
        operationalStatus: "BLOCKED_BY_ENTITLEMENT",
        blockedReason: "LIST_OVER_LIMIT",
        createdAt: "2026-09-02T10:00:00.000Z",
      }),
      summary({ id: "monitor-3", name: "Scanning fine" }),
    ]);

    render(<MonitorsPage />);

    // The switch shows the intent — all three are enabled — and a monitor the plan stopped says
    // so under it (UI-021): "Paused — plan limit", with its reason as text rather than a tooltip.
    // A monitor that is simply enabled gets no second "Enabled" pill beside its switch.
    const pills = await screen.findAllByTestId("monitor-state-pill");
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "Paused — plan limit",
      "Paused — plan limit",
    ]);
    expect(pills.map((pill) => pill.getAttribute("data-blocked-reason"))).toEqual([
      "MONITOR_CAPACITY",
      "LIST_OVER_LIMIT",
    ]);
    expect(
      screen
        .getAllByTestId("monitor-enabled-switch")
        .map((toggle) => toggle.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "true"]);
    // Paused monitors are evaluating nothing, so none of them is shown catching up.
    expect(screen.queryByTestId("monitor-synchronization")).toBeNull();
    expect(
      screen.getAllByTestId("monitor-state-reason").map((reason) => reason.textContent),
    ).toEqual([
      blockedShortReason("MONITOR_CAPACITY"),
      blockedShortReason("LIST_OVER_LIMIT"),
    ]);
    expect(screen.queryByText("Not scanning")).toBeNull();
    expect(pills.some((pill) => pill.hasAttribute("title"))).toBe(false);
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
    await userEvent.click(await screen.findByTestId("monitor-enabled-switch"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("monitor-enabled-switch").getAttribute("aria-checked"),
      ).toBe("false");
    });
    // The menu holds what is not the switch.
    await openOverflowMenu(userEvent, "Value entries");
    expect(screen.queryByTestId("toggle-monitor")).toBeNull();
  });

  it("re-enables a disabled monitor", async () => {
    fetchMonitorsMock
      .mockResolvedValueOnce([summary({ enabled: false })])
      .mockResolvedValue([summary({ enabled: true })]);
    updateMonitorMock.mockResolvedValue(summary({ enabled: true }));

    render(<MonitorsPage />);
    const toggle = await screen.findByTestId("monitor-enabled-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("monitor-enabled-switch").getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("leaves the row on its real state when the toggle fails", async () => {
    fetchMonitorsMock.mockResolvedValue([summary()]);
    updateMonitorMock.mockRejectedValue(new Error("network"));

    render(<MonitorsPage />);
    await userEvent.click(await screen.findByTestId("monitor-enabled-switch"));

    await waitFor(() => {
      expect(
        screen.getByText("That change did not save. Value entries is still", {
          exact: false,
        }),
      ).toBeDefined();
    });
    // Nothing was applied optimistically, so the row still shows what the server holds…
    const toggle = screen.getByTestId("monitor-enabled-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // …and the switch is usable again rather than stuck pending.
    expect(toggle.hasAttribute("disabled")).toBe(false);
  });

  it("says when an enabled monitor is catching up on its window, and re-reads until it is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const synchronizing = summary({
        synchronization: {
          state: "SYNCHRONIZING",
          windowStart: "2026-09-24",
          currentMembers: 12,
          coveredMembers: 0,
          awaitingMembers: 12,
        },
      });
      fetchMonitorsMock.mockResolvedValueOnce([synchronizing]).mockResolvedValue([
        summary({
          synchronization: {
            state: "SYNCHRONIZED",
            windowStart: "2026-09-24",
            currentMembers: 12,
            coveredMembers: 12,
            awaitingMembers: 0,
          },
        }),
      ]);

      render(<MonitorsPage />);

      const note = await screen.findByTestId("monitor-synchronization");
      expect(note.getAttribute("data-state")).toBe("SYNCHRONIZING");
      expect(note.textContent).toContain("Synchronizing");
      expect(note.textContent).toContain("Evaluating the last 30 days");
      expect(fetchMonitorsMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);
      await waitFor(() =>
        expect(screen.queryByTestId("monitor-synchronization")).toBeNull(),
      );
      expect(fetchMonitorsMock).toHaveBeenCalledTimes(2);
      // Synchronized: nothing else is re-read.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMonitorsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("states partial coverage honestly, and nothing for a disabled monitor", async () => {
    fetchMonitorsMock.mockResolvedValue([
      summary({
        synchronization: {
          state: "PARTIAL",
          windowStart: "2026-09-24",
          currentMembers: 12,
          coveredMembers: 10,
          awaitingMembers: 1,
          historyFrom: "2026-10-14",
        },
      }),
      summary({
        id: "monitor-2",
        name: "Switched off",
        enabled: false,
        operationalStatus: "DISABLED",
      }),
    ]);

    render(<MonitorsPage />);

    const notes = await screen.findAllByTestId("monitor-synchronization");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.getAttribute("data-state")).toBe("PARTIAL");
    expect(notes[0]!.textContent).toContain(
      "1 of 12 stocks waiting for market data",
    );
    expect(notes[0]!.textContent).toContain("History recorded since Oct 14, 2026");
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
