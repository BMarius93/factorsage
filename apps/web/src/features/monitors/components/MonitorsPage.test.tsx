import type {
  MonitorDetailResponse,
  MonitorSummaryResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import {
  createMonitor,
  deleteMonitor,
  fetchMonitors,
  updateMonitor,
} from "../api/monitors-api";
import { MonitorsPage } from "./MonitorsPage";

vi.mock("../api/monitors-api", () => ({
  fetchMonitors: vi.fn(),
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  deleteMonitor: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const fetchMonitorsMock = vi.mocked(fetchMonitors);
const createMonitorMock = vi.mocked(createMonitor);
const updateMonitorMock = vi.mocked(updateMonitor);
const deleteMonitorMock = vi.mocked(deleteMonitor);
const fetchStrategiesMock = vi.mocked(fetchStrategies);
const fetchStockListsMock = vi.mocked(fetchStockLists);

const STRATEGIES: StrategySummaryResponse[] = [
  {
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
    id: "list-1",
    name: "Quality compounders",
    itemCount: 12,
    compliance: { symbolCount: 12, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  {
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
});

describe("MonitorsPage", () => {
  it("shows the empty state with a create call to action", async () => {
    fetchMonitorsMock.mockResolvedValue([]);

    render(<MonitorsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("monitors-empty")).toBeDefined();
    });
    expect(screen.getByText("Create your first monitor")).toBeDefined();
    expect(screen.queryByTestId("monitors-grid")).toBeNull();
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
    expect(screen.getByText("Deep value")).toBeDefined();
    expect(screen.getByText("Quality compounders")).toBeDefined();
    expect(screen.getByText("12 stocks")).toBeDefined();
    expect(screen.getByText("3 active signals")).toBeDefined();
    expect(screen.getByText(/^Checked /)).toBeDefined();

    expect(screen.getByText("Enabled")).toBeDefined();
    expect(screen.getByText("Disabled")).toBeDefined();
    // A monitor that has never been included in a cycle says so rather than borrowing a timestamp.
    expect(screen.getByText("Not checked yet")).toBeDefined();
    expect(screen.getByText("1 stock")).toBeDefined();

    // The strategy and the list a monitor references stay reachable from the row.
    expect(
      screen.getByRole("link", { name: "Deep value" }).getAttribute("href"),
    ).toBe("/strategies/strategy-1");
    expect(
      screen
        .getByRole("link", { name: "Quality compounders" })
        .getAttribute("href"),
    ).toBe("/lists/list-1");
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
      .mockResolvedValue([summary({ id: "monitor-new", name: "Value entries" })]);
    createMonitorMock.mockResolvedValue(
      detail({ id: "monitor-new", name: "Value entries" }),
    );

    render(<MonitorsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("monitors-empty")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Create your first monitor"));
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });

    await userEvent.type(screen.getByLabelText("Name"), "Value entries");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
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
    expect(screen.getByTestId("toggle-monitor").textContent).toBe("Disable");
    // And the action is usable again rather than stuck pending.
    expect(
      screen.getByTestId("toggle-monitor").hasAttribute("disabled"),
    ).toBe(false);
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

    await userEvent.click(screen.getByText("Delete"));
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
      screen
        .getByRole("link", { name: "Value entries" })
        .getAttribute("href"),
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

    await userEvent.click(screen.getByText("Edit"));
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
      expect(screen.getByText("Deep value")).toBeDefined();
    });

    await userEvent.click(screen.getByText("Edit"));
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-2");
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
      expect(screen.getByText("Momentum exits")).toBeDefined();
    });
    expect(screen.getByText("Tech universe")).toBeDefined();
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
