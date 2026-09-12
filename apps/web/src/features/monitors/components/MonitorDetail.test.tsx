import type {
  MonitorDetailResponse,
  MonitorSecurityEvaluationResponse,
  MonitorSignalResponse,
  MonitorSummaryResponse,
  StockListSummaryResponse,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import {
  deleteMonitor,
  fetchMonitor,
  updateMonitor,
} from "../api/monitors-api";
import { MonitorDetail } from "./MonitorDetail";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../api/monitors-api", () => ({
  fetchMonitor: vi.fn(),
  updateMonitor: vi.fn(),
  deleteMonitor: vi.fn(),
  createMonitor: vi.fn(),
}));

vi.mock("../../strategies/api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
}));

vi.mock("../../lists/api/stock-lists-api", () => ({
  fetchStockLists: vi.fn(),
}));

const fetchMonitorMock = vi.mocked(fetchMonitor);
const updateMonitorMock = vi.mocked(updateMonitor);
const deleteMonitorMock = vi.mocked(deleteMonitor);
const fetchStrategiesMock = vi.mocked(fetchStrategies);
const fetchStockListsMock = vi.mocked(fetchStockLists);

const STRATEGIES: StrategySummaryResponse[] = [
  {
    id: "strategy-1",
    name: "Deep value",
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "strategy-2",
    name: "Momentum exits",
    buyLevelCount: 1,
    sellLevelCount: 1,
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
    itemCount: 2,
    compliance: { symbolCount: 2, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "list-2",
    name: "Tech universe",
    itemCount: 3,
    compliance: { symbolCount: 3, symbolLimit: 100, compliant: true },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];

function security(id: string, symbol: string, name: string) {
  return { id, symbol, name, exchangeCode: "NASDAQ" };
}

function evaluation(
  overrides: Partial<MonitorSecurityEvaluationResponse> & {
    security: MonitorSecurityEvaluationResponse["security"];
  },
): MonitorSecurityEvaluationResponse {
  return {
    status: "NOT_CHECKED",
    matchedLevels: [],
    ...overrides,
  };
}

function signal(
  overrides: Partial<MonitorSignalResponse> = {},
): MonitorSignalResponse {
  return {
    id: "signal-1",
    security: security("sec-1", "AAA", "Alpha Corp"),
    levelKind: "BUY",
    levelId: "buy-1",
    kind: "CONDITION",
    observationDate: "2026-09-11",
    observationPrice: 101.5,
    detectedAt: "2026-09-11T15:30:00.000Z",
    ...overrides,
  };
}

function detail(
  overrides: Partial<MonitorDetailResponse> = {},
): MonitorDetailResponse {
  const base: MonitorSummaryResponse = {
    id: "monitor-1",
    name: "Value entries",
    enabled: true,
    strategyId: "strategy-1",
    strategyName: "Deep value",
    stockListId: "list-1",
    stockListName: "Quality compounders",
    securityCount: 2,
    activeSignalCount: 1,
    operationalStatus: "ACTIVE" as const,
    lastScanAt: "2026-09-12T13:42:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
  return { ...base, securities: [], signals: [], ...overrides };
}

async function detailReady() {
  await waitFor(() => {
    expect(screen.getByTestId("monitor-detail")).toBeDefined();
  });
}

beforeEach(() => {
  push.mockReset();
  fetchMonitorMock.mockReset();
  updateMonitorMock.mockReset();
  deleteMonitorMock.mockReset();
  fetchStrategiesMock.mockReset().mockResolvedValue(STRATEGIES);
  fetchStockListsMock.mockReset().mockResolvedValue(LISTS);
});

describe("MonitorDetail", () => {
  it("shows what the monitor watches, with its state and last checked time", async () => {
    fetchMonitorMock.mockResolvedValue(detail());

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    expect(screen.getByRole("heading", { name: "Value entries" })).toBeDefined();
    expect(screen.getByTestId("monitor-enabled-pill").textContent).toBe(
      "Enabled",
    );
    // Scoped to the configuration panel: the list is also linked from the empty-state sentence
    // below it, which is a different, actionable mention of the same thing.
    const facts = screen.getByRole("region", { name: "Monitor configuration" });
    expect(
      within(facts).getByRole("link", { name: "Deep value" }).getAttribute("href"),
    ).toBe("/strategies/strategy-1");
    expect(
      within(facts)
        .getByRole("link", { name: "Quality compounders" })
        .getAttribute("href"),
    ).toBe("/lists/list-1");
    expect(within(facts).getByText("2 stocks")).toBeDefined();
    expect(within(facts).getByText("1 active signal")).toBeDefined();
    // An actual date and time, not a vague relative label.
    const checked = screen.getByTestId("monitor-last-checked").textContent ?? "";
    expect(checked).toMatch(/Sep 12, 2026/);
    expect(checked).toMatch(/\d{1,2}:\d{2}/);
    expect(fetchMonitorMock).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when no cycle has checked it yet", async () => {
    fetchMonitorMock.mockResolvedValue(detail({ lastScanAt: undefined }));

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    expect(screen.getByTestId("monitor-last-checked").textContent).toBe(
      "Not checked yet",
    );
  });

  it("distinguishes all four security statuses without inventing any", async () => {
    fetchMonitorMock.mockResolvedValue(
      detail({
        securityCount: 4,
        securities: [
          evaluation({
            security: security("sec-1", "AAA", "Alpha Corp"),
            status: "MATCHED",
            statusSince: "2026-09-12T13:00:00.000Z",
            matchedLevels: [
              {
                levelId: "buy-1",
                levelKind: "BUY",
                kind: "TRIGGER",
                signalId: "signal-1",
                observationPrice: 212.5,
                detectedAt: "2026-09-12T13:00:00.000Z",
              },
            ],
          }),
          evaluation({
            security: security("sec-2", "BBB", "Beta Ltd"),
            status: "NO_MATCH",
            statusSince: "2026-09-12T13:00:00.000Z",
          }),
          evaluation({
            security: security("sec-3", "CCC", "Gamma Inc"),
            status: "NOT_EVALUABLE",
            statusSince: "2026-09-12T13:00:00.000Z",
          }),
          evaluation({ security: security("sec-4", "DDD", "Delta Co") }),
        ],
      }),
    );

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    const rows = screen.getAllByTestId("monitor-security-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Matched")).toBeDefined();
    expect(within(rows[1]!).getByText("No match")).toBeDefined();
    expect(within(rows[2]!).getByText("Not evaluable")).toBeDefined();
    expect(within(rows[3]!).getByText("Not checked yet")).toBeDefined();

    // The matched row explains itself through its Signal, and carries the observed price.
    expect(within(rows[0]!).getByText("Buy · Trigger")).toBeDefined();
    expect(within(rows[0]!).getByText("$212.50")).toBeDefined();
    // A security that did not match has no stored price, so none is shown rather than a fake zero.
    expect(within(rows[1]!).queryByText(/\$/)).toBeNull();
    // And a never-checked one has no status timestamp either.
    expect(within(rows[3]!).queryByText(/Sep/)).toBeNull();
  });

  it("lists recent signals newest-first with their state", async () => {
    fetchMonitorMock.mockResolvedValue(
      detail({
        signals: [
          signal({ id: "signal-2", kind: "TRIGGER", levelKind: "SELL" }),
          signal({
            id: "signal-3",
            resolvedAt: "2026-09-11T20:00:00.000Z",
            security: security("sec-2", "BBB", "Beta Ltd"),
          }),
        ],
      }),
    );

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    const rows = screen.getAllByTestId("monitor-signal-row");
    expect(rows).toHaveLength(2);
    // Order is the API's; the page does not re-sort it.
    expect(within(rows[0]!).getByText("Sell · Trigger")).toBeDefined();
    expect(within(rows[0]!).getByText("Active")).toBeDefined();
    expect(within(rows[1]!).getByText("Buy · Condition")).toBeDefined();
    expect(within(rows[1]!).getByText(/^Ended /)).toBeDefined();
    expect(within(rows[1]!).getByText("$101.50")).toBeDefined();
    // Under the window cap, so nothing claims to be truncated.
    expect(screen.queryByTestId("monitor-signals-window")).toBeNull();
  });

  it("is honest that a full page of signals is only the most recent", async () => {
    fetchMonitorMock.mockResolvedValue(
      detail({
        signals: Array.from({ length: 100 }, (_unused, index) =>
          signal({ id: `signal-${index}` }),
        ),
      }),
    );

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    expect(screen.getByTestId("monitor-signals-window").textContent).toContain(
      "100 most recent",
    );
  });

  it("shows empty sections rather than pretending there is data", async () => {
    fetchMonitorMock.mockResolvedValue(
      detail({ securityCount: 0, activeSignalCount: 0 }),
    );

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    expect(screen.getByTestId("monitor-securities-empty")).toBeDefined();
    expect(screen.getByTestId("monitor-signals-empty")).toBeDefined();
    expect(screen.getByText("No active signals")).toBeDefined();
  });

  it("reports a load failure and recovers through retry", async () => {
    fetchMonitorMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(detail({ name: "Recovered" }));

    render(<MonitorDetail monitorId="monitor-1" />);
    await waitFor(() => {
      expect(
        screen.getByText("This monitor could not be loaded"),
      ).toBeDefined();
    });

    await userEvent.click(screen.getByText("Try again"));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Recovered" })).toBeDefined();
    });
  });

  it("says a deleted monitor is gone instead of offering a pointless retry", async () => {
    fetchMonitorMock.mockRejectedValue(new ApiError(404, "Monitor was not found"));

    render(<MonitorDetail monitorId="monitor-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("monitor-missing")).toBeDefined();
    });
    expect(screen.queryByText("Try again")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back to monitors" }).getAttribute("href"),
    ).toBe("/monitors");
  });

  it("disables and re-enables from the detail header", async () => {
    fetchMonitorMock.mockResolvedValue(detail());
    updateMonitorMock.mockResolvedValue({ ...detail(), enabled: false });

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    await userEvent.click(screen.getByTestId("toggle-monitor"));

    await waitFor(() => {
      expect(updateMonitorMock).toHaveBeenCalledWith("monitor-1", {
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("monitor-enabled-pill").textContent).toBe(
        "Disabled",
      );
    });
    expect(screen.getByTestId("toggle-monitor").textContent).toBe("Enable");
  });

  it("leaves the header on its real state when a toggle fails", async () => {
    fetchMonitorMock.mockResolvedValue(detail());
    updateMonitorMock.mockRejectedValue(new Error("network"));

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    await userEvent.click(screen.getByTestId("toggle-monitor"));

    await waitFor(() => {
      expect(
        screen.getByText(/That change did not save/),
      ).toBeDefined();
    });
    expect(screen.getByTestId("monitor-enabled-pill").textContent).toBe(
      "Enabled",
    );
    expect(
      screen.getByTestId("toggle-monitor").hasAttribute("disabled"),
    ).toBe(false);
  });

  it("re-reads the monitor after an edit rebinds it", async () => {
    fetchMonitorMock
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        detail({
          strategyId: "strategy-2",
          strategyName: "Momentum exits",
          stockListId: "list-2",
          stockListName: "Tech universe",
          lastScanAt: undefined,
          activeSignalCount: 0,
          securities: [],
          signals: [],
        }),
      );
    updateMonitorMock.mockResolvedValue({
      ...detail(),
      strategyId: "strategy-2",
      strategyName: "Momentum exits",
    });

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();
    expect(screen.getByText("Deep value")).toBeDefined();

    await userEvent.click(screen.getByTestId("edit-monitor"));
    await waitFor(() => {
      expect(screen.getByTestId("monitor-form")).toBeDefined();
    });
    await userEvent.selectOptions(
      screen.getByLabelText("Strategy"),
      "strategy-2",
    );
    await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-2");
    await userEvent.click(screen.getByText("Save changes"));

    // A rebind changes the whole evaluation table, so the page re-reads instead of patching.
    await waitFor(() => {
      expect(fetchMonitorMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText("Momentum exits")).toBeDefined();
    });
    expect(
      within(
        screen.getByRole("region", { name: "Monitor configuration" }),
      ).getByText("Tech universe"),
    ).toBeDefined();
    // The new configuration has not been checked, and the page says exactly that.
    expect(screen.getByTestId("monitor-last-checked").textContent).toBe(
      "Not checked yet",
    );
  });

  it("deletes from the detail page only after confirmation, then leaves", async () => {
    fetchMonitorMock.mockResolvedValue(detail());
    deleteMonitorMock.mockResolvedValue(undefined);

    render(<MonitorDetail monitorId="monitor-1" />);
    await detailReady();

    await userEvent.click(screen.getByTestId("delete-monitor"));
    expect(screen.getByTestId("confirm-dialog")).toBeDefined();
    expect(deleteMonitorMock).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete monitor" }),
    );

    await waitFor(() => {
      expect(deleteMonitorMock).toHaveBeenCalledWith("monitor-1");
    });
    expect(push).toHaveBeenCalledWith("/monitors");
  });
});
