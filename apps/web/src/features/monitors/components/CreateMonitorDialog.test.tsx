import type {
  MonitorDetailResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createMonitor } from "../api/monitors-api";
import { CreateMonitorDialog } from "./CreateMonitorDialog";

vi.mock("../api/monitors-api", () => ({
  createMonitor: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const createMonitorMock = vi.mocked(createMonitor);
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

const CREATED: MonitorDetailResponse = {
  id: "monitor-new",
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
  signals: [],
};

const onCreated = vi.fn();
const onClose = vi.fn();

function renderDialog() {
  return render(
    <CreateMonitorDialog onCreated={onCreated} onClose={onClose} />,
  );
}

async function fillRequiredFields() {
  await userEvent.type(screen.getByLabelText("Name"), "Value entries");
  await userEvent.selectOptions(
    screen.getByLabelText("Strategy"),
    "strategy-1",
  );
  await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
}

beforeEach(() => {
  onCreated.mockReset();
  onClose.mockReset();
  createMonitorMock.mockReset();
  fetchStrategiesMock
    .mockReset()
    .mockResolvedValue([
      strategy("strategy-1", "Deep value"),
      strategy("strategy-2", "Momentum exits"),
    ]);
  fetchStockListsMock
    .mockReset()
    .mockResolvedValue([list("list-1", "Core universe")]);
});

describe("CreateMonitorDialog", () => {
  it("offers the caller's own strategies and lists as the only choices", async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    // Both collections come from the endpoints that own them, which scope to the authenticated
    // caller — the dialog never filters ownership itself.
    expect(fetchStrategiesMock).toHaveBeenCalledTimes(1);
    expect(fetchStockListsMock).toHaveBeenCalledTimes(1);

    const strategySelect = screen.getByLabelText("Strategy");
    expect(
      Array.from(strategySelect.querySelectorAll("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Select a strategy…", "Deep value", "Momentum exits"]);
    expect(
      Array.from(
        screen.getByLabelText("Stock list").querySelectorAll("option"),
      ).map((option) => option.textContent),
    ).toEqual(["Select a stock list…", "Core universe"]);
  });

  it("creates an enabled monitor from the three chosen fields", async () => {
    createMonitorMock.mockResolvedValue(CREATED);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await fillRequiredFields();
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(createMonitorMock).toHaveBeenCalledWith({
        name: "Value entries",
        strategyId: "strategy-1",
        stockListId: "list-1",
        enabled: true,
      });
    });
    expect(onCreated).toHaveBeenCalledWith(CREATED);
  });

  it("creates a disabled monitor when start-now is cleared", async () => {
    createMonitorMock.mockResolvedValue({ ...CREATED, enabled: false });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await fillRequiredFields();
    await userEvent.click(screen.getByLabelText(/Start monitoring now/));
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(createMonitorMock).toHaveBeenCalledWith({
        name: "Value entries",
        strategyId: "strategy-1",
        stockListId: "list-1",
        enabled: false,
      });
    });
  });

  it("names every missing field instead of submitting", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await userEvent.click(screen.getByTestId("submit-monitor"));

    expect(screen.getByText("A monitor needs a name.")).toBeDefined();
    expect(screen.getByText("Choose a strategy.")).toBeDefined();
    expect(screen.getByText("Choose a stock list.")).toBeDefined();
    expect(createMonitorMock).not.toHaveBeenCalled();
  });

  it("still refuses a name of only whitespace", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

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
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

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
    // A request that never settles: the guard, not the response, is what is under test.
    createMonitorMock.mockReturnValue(new Promise<never>(() => {}));
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await fillRequiredFields();
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
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await fillRequiredFields();
    await userEvent.click(screen.getByTestId("submit-monitor"));

    // The API's own product message, not a generic banner.
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-error").textContent).toBe(
        "Stock list was not found",
      );
    });
    // Nothing was reported as created, and the user's input survives for a second attempt.
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveProperty(
      "value",
      "Value entries",
    );
    expect(screen.getByTestId("submit-monitor").textContent).toBe(
      "Create monitor",
    );

    createMonitorMock.mockResolvedValue(CREATED);
    await userEvent.click(screen.getByTestId("submit-monitor"));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(CREATED);
    });
  });

  it("reports a transient failure in its own words", async () => {
    createMonitorMock.mockRejectedValue(new Error("network"));
    renderDialog();
    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });

    await fillRequiredFields();
    await userEvent.click(screen.getByTestId("submit-monitor"));

    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-error").textContent).toBe(
        "The monitor could not be created right now. Try again in a moment.",
      );
    });
  });

  it("explains what to create first when there is no strategy", async () => {
    fetchStrategiesMock.mockResolvedValue([]);
    renderDialog();

    await waitFor(() => {
      expect(screen.getByTestId("monitor-prerequisites")).toBeDefined();
    });
    // No half-populated picker to submit.
    expect(screen.queryByTestId("create-monitor-form")).toBeNull();
    expect(screen.getByText(/no strategy yet/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Create a strategy" })
        .getAttribute("href"),
    ).toBe("/strategies/new");
    expect(screen.queryByRole("link", { name: "Create a stock list" })).toBeNull();
  });

  it("explains what to create first when there is no stock list", async () => {
    fetchStockListsMock.mockResolvedValue([]);
    renderDialog();

    await waitFor(() => {
      expect(screen.getByTestId("monitor-prerequisites")).toBeDefined();
    });
    expect(screen.queryByTestId("create-monitor-form")).toBeNull();
    expect(screen.getByText(/no stock list yet/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Create a stock list" })
        .getAttribute("href"),
    ).toBe("/lists");
    expect(screen.queryByRole("link", { name: "Create a strategy" })).toBeNull();
  });

  it("offers both paths forward when neither exists", async () => {
    fetchStrategiesMock.mockResolvedValue([]);
    fetchStockListsMock.mockResolvedValue([]);
    renderDialog();

    await waitFor(() => {
      expect(screen.getByTestId("monitor-prerequisites")).toBeDefined();
    });
    expect(
      screen.getByText(/do not have a strategy or a stock list yet/),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Create a strategy" })).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Create a stock list" }),
    ).toBeDefined();
  });

  it("recovers through retry when the choices could not be loaded", async () => {
    fetchStrategiesMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([strategy("strategy-1", "Deep value")]);
    renderDialog();

    await waitFor(() => {
      expect(
        screen.getByText(/Your strategies and lists could not be loaded/),
      ).toBeDefined();
    });
    expect(screen.queryByTestId("create-monitor-form")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByTestId("create-monitor-form")).toBeDefined();
    });
    expect(screen.getByLabelText("Strategy")).toBeDefined();
  });
});
