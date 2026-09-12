import type {
  MonitorDetailResponse,
  MonitorSummaryResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createMonitor, updateMonitor } from "../api/monitors-api";
import { MonitorFormDialog } from "./MonitorFormDialog";

vi.mock("../api/monitors-api", () => ({
  createMonitor: vi.fn(),
  updateMonitor: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const createMonitorMock = vi.mocked(createMonitor);
const updateMonitorMock = vi.mocked(updateMonitor);
const fetchStrategiesMock = vi.mocked(fetchStrategies);
const fetchStockListsMock = vi.mocked(fetchStockLists);

function strategy(id: string, name: string): StrategySummaryResponse {
  return {
    id,
    name,
    buyLevelCount: 1,
    sellLevelCount: 1,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  };
}

function list(id: string, name: string): StockListSummaryResponse {
  return {
    id,
    name,
    itemCount: 4,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  };
}

const SUMMARY: MonitorSummaryResponse = {
  id: "monitor-1",
  name: "Value entries",
  enabled: true,
  strategyId: "strategy-1",
  strategyName: "Deep value",
  stockListId: "list-1",
  stockListName: "Core universe",
  securityCount: 4,
  activeSignalCount: 0,
  createdAt: "2026-09-12T10:00:00.000Z",
  updatedAt: "2026-09-12T10:00:00.000Z",
};

const CREATED: MonitorDetailResponse = {
  ...SUMMARY,
  id: "monitor-new",
  securities: [],
  signals: [],
};

const onSaved = vi.fn();
const onClose = vi.fn();

function renderCreate() {
  return render(
    <MonitorFormDialog mode="create" onSaved={onSaved} onClose={onClose} />,
  );
}

function renderEdit(overrides: Partial<MonitorSummaryResponse> = {}) {
  return render(
    <MonitorFormDialog
      mode="edit"
      monitor={{ ...SUMMARY, ...overrides }}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
}

async function formReady() {
  await waitFor(() => {
    expect(screen.getByTestId("monitor-form")).toBeDefined();
  });
}

beforeEach(() => {
  onSaved.mockReset();
  onClose.mockReset();
  createMonitorMock.mockReset();
  updateMonitorMock.mockReset();
  fetchStrategiesMock
    .mockReset()
    .mockResolvedValue([
      strategy("strategy-1", "Deep value"),
      strategy("strategy-2", "Momentum exits"),
    ]);
  fetchStockListsMock
    .mockReset()
    .mockResolvedValue([
      list("list-1", "Core universe"),
      list("list-2", "Tech universe"),
    ]);
});

describe("MonitorFormDialog — create", () => {
  it("offers the caller's own strategies and lists as the only choices", async () => {
    renderCreate();
    await formReady();

    // Both collections come from the endpoints that own them, which scope to the authenticated
    // caller — the dialog never filters ownership itself.
    expect(fetchStrategiesMock).toHaveBeenCalledTimes(1);
    expect(fetchStockListsMock).toHaveBeenCalledTimes(1);
    expect(
      Array.from(
        screen.getByLabelText("Strategy").querySelectorAll("option"),
      ).map((option) => option.textContent),
    ).toEqual(["Select a strategy…", "Deep value", "Momentum exits"]);
    expect(
      Array.from(
        screen.getByLabelText("Stock list").querySelectorAll("option"),
      ).map((option) => option.textContent),
    ).toEqual(["Select a stock list…", "Core universe", "Tech universe"]);
  });

  it("creates an enabled monitor from the three chosen fields", async () => {
    createMonitorMock.mockResolvedValue(CREATED);
    renderCreate();
    await formReady();

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
    expect(onSaved).toHaveBeenCalledWith(CREATED);
  });

  it("creates a disabled monitor when start-now is cleared", async () => {
    createMonitorMock.mockResolvedValue({ ...CREATED, enabled: false });
    renderCreate();
    await formReady();

    await userEvent.type(screen.getByLabelText("Name"), "Value entries");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    await userEvent.click(screen.getByLabelText(/Start monitoring now/));
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(createMonitorMock).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  it("names every missing field instead of submitting", async () => {
    renderCreate();
    await formReady();

    await userEvent.click(screen.getByTestId("submit-monitor"));

    expect(screen.getByText("A monitor needs a name.")).toBeDefined();
    expect(screen.getByText("Choose a strategy.")).toBeDefined();
    expect(screen.getByText("Choose a stock list.")).toBeDefined();
    expect(createMonitorMock).not.toHaveBeenCalled();
  });

  it("still refuses a name of only whitespace", async () => {
    renderCreate();
    await formReady();

    await userEvent.type(screen.getByLabelText("Name"), "   ");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    await userEvent.click(screen.getByTestId("submit-monitor"));

    expect(screen.getByText("A monitor needs a name.")).toBeDefined();
    expect(createMonitorMock).not.toHaveBeenCalled();
  });

  it("clears a field's complaint as soon as it is answered", async () => {
    renderCreate();
    await formReady();

    await userEvent.click(screen.getByTestId("submit-monitor"));
    expect(screen.getByText("Choose a strategy.")).toBeDefined();

    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    expect(screen.queryByText("Choose a strategy.")).toBeNull();
    expect(screen.getByText("Choose a stock list.")).toBeDefined();
  });

  it("submits once however often the button is pressed", async () => {
    createMonitorMock.mockReturnValue(new Promise<never>(() => {}));
    renderCreate();
    await formReady();

    await userEvent.type(screen.getByLabelText("Name"), "Value entries");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    const submit = screen.getByTestId("submit-monitor");
    await userEvent.click(submit);
    await userEvent.click(submit);
    await userEvent.click(submit);

    expect(createMonitorMock).toHaveBeenCalledTimes(1);
    expect(submit.textContent).toBe("Creating…");
    expect(submit.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the filled form usable when the API refuses the request", async () => {
    createMonitorMock.mockRejectedValue(
      new ApiError(400, "Stock list was not found"),
    );
    renderCreate();
    await formReady();

    await userEvent.type(screen.getByLabelText("Name"), "Value entries");
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(screen.getByTestId("monitor-form-error").textContent).toBe(
        "Stock list was not found",
      );
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveProperty(
      "value",
      "Value entries",
    );

    createMonitorMock.mockResolvedValue(CREATED);
    await userEvent.click(screen.getByTestId("submit-monitor"));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(CREATED);
    });
  });

  it("explains what to create first when there is no strategy", async () => {
    fetchStrategiesMock.mockResolvedValue([]);
    renderCreate();

    await waitFor(() => {
      expect(screen.getByTestId("monitor-prerequisites")).toBeDefined();
    });
    expect(screen.queryByTestId("monitor-form")).toBeNull();
    expect(screen.getByText(/no strategy yet/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Create a strategy" })
        .getAttribute("href"),
    ).toBe("/strategies/new");
  });

  it("explains what to create first when there is no stock list", async () => {
    fetchStockListsMock.mockResolvedValue([]);
    renderCreate();

    await waitFor(() => {
      expect(screen.getByTestId("monitor-prerequisites")).toBeDefined();
    });
    expect(screen.getByText(/no stock list yet/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Create a stock list" })
        .getAttribute("href"),
    ).toBe("/lists");
  });

  it("recovers through retry when the choices could not be loaded", async () => {
    fetchStrategiesMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([strategy("strategy-1", "Deep value")]);
    renderCreate();

    await waitFor(() => {
      expect(
        screen.getByText(/Your strategies and lists could not be loaded/),
      ).toBeDefined();
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await formReady();
    expect(screen.getByLabelText("Strategy")).toBeDefined();
  });
});

describe("MonitorFormDialog — edit", () => {
  it("prepopulates everything the monitor already is", async () => {
    renderEdit({ enabled: false });
    await formReady();

    expect(screen.getByLabelText("Name")).toHaveProperty(
      "value",
      "Value entries",
    );
    expect(screen.getByLabelText("Strategy")).toHaveProperty(
      "value",
      "strategy-1",
    );
    expect(screen.getByLabelText("Stock list")).toHaveProperty(
      "value",
      "list-1",
    );
    expect(screen.getByLabelText(/Enabled/)).toHaveProperty("checked", false);
    // Nothing has moved, so nothing is warned about.
    expect(screen.queryByTestId("monitor-rebind-note")).toBeNull();
  });

  it("changes only the name without rebinding anything", async () => {
    updateMonitorMock.mockResolvedValue({ ...SUMMARY, name: "Renamed" });
    renderEdit();
    await formReady();

    const nameInput = screen.getByLabelText("Name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed");
    expect(screen.queryByTestId("monitor-rebind-note")).toBeNull();
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        name: "Renamed",
        strategyId: "strategy-1",
        stockListId: "list-1",
        enabled: true,
      });
    });
  });

  it("rebinds the strategy and explains the consequence", async () => {
    updateMonitorMock.mockResolvedValue({
      ...SUMMARY,
      strategyId: "strategy-2",
      strategyName: "Momentum exits",
    });
    renderEdit();
    await formReady();

    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    expect(screen.getByTestId("monitor-rebind-note").textContent).toContain(
      "from the next scan",
    );
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        name: "Value entries",
        strategyId: "strategy-2",
        stockListId: "list-1",
        enabled: true,
      });
    });
  });

  it("rebinds the stock list", async () => {
    updateMonitorMock.mockResolvedValue({
      ...SUMMARY,
      stockListId: "list-2",
      stockListName: "Tech universe",
    });
    renderEdit();
    await formReady();

    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-2");
    expect(screen.getByTestId("monitor-rebind-note")).toBeDefined();
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith(
        "monitor-1",
        expect.objectContaining({ stockListId: "list-2" }),
      );
    });
  });

  it("rebinds both and toggles enabled in one save", async () => {
    updateMonitorMock.mockResolvedValue({ ...SUMMARY, enabled: false });
    renderEdit();
    await formReady();

    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-2");
    await userEvent.click(screen.getByLabelText(/Enabled/));
    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        name: "Value entries",
        strategyId: "strategy-2",
        stockListId: "list-2",
        enabled: false,
      });
    });
  });

  it("stops warning when the selection is put back", async () => {
    renderEdit();
    await formReady();

    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    expect(screen.getByTestId("monitor-rebind-note")).toBeDefined();
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-1",
    );
    expect(screen.queryByTestId("monitor-rebind-note")).toBeNull();
  });

  it("is never blocked by prerequisites", async () => {
    // An existing monitor references a strategy and a list, so neither collection can be empty for
    // it. Even an unexpected empty answer must not replace the edit form with a create-first notice.
    fetchStrategiesMock.mockResolvedValue([]);
    fetchStockListsMock.mockResolvedValue([]);
    renderEdit();
    await formReady();

    expect(screen.queryByTestId("monitor-prerequisites")).toBeNull();
  });

  it("reports a save failure without closing", async () => {
    updateMonitorMock.mockRejectedValue(new Error("network"));
    renderEdit();
    await formReady();

    await userEvent.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByTestId("monitor-form-error").textContent).toBe(
        "The monitor could not be saved right now. Try again in a moment.",
      );
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
