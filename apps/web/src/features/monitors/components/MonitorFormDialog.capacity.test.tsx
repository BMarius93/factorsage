import {
  PLAN_ENTITLEMENTS,
  type MonitorDetailResponse,
  type StockListSummaryResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import { fetchStockLists } from "../../lists/api/stock-lists-api";
import { fetchStrategies } from "../../strategies/api/strategies-api";
import { createMonitor } from "../api/monitors-api";
import { MonitorFormDialog } from "./MonitorFormDialog";

/**
 * The New Monitor dialog at the plan's active-monitor capacity (UI-022): it offers the monitor
 * switched off and says why, and a capacity refusal offers the switched-off save instead of a
 * dead end. The API still decides; this is the path forward it already allows.
 */

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
vi.mock("../../auth/hooks/use-entitlements", () => ({
  useEntitlements: () => ({
    status: "ready",
    plan: "FREE",
    role: "USER",
    entitlements: PLAN_ENTITLEMENTS.FREE,
  }),
}));

const createMonitorMock = vi.mocked(createMonitor);

const strategy = (id: string): StrategySummaryResponse => ({
  ownership: "USER",
  canEdit: true,
  id,
  name: "Deep value",
  buyLevelCount: 1,
  sellLevelCount: 0,
  hasFinalExit: false,
  versionNumber: 1,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
});
const list = (id: string): StockListSummaryResponse => ({
  ownership: "USER",
  canEdit: true,
  id,
  name: "Core universe",
  itemCount: 4,
  compliance: { symbolCount: 4, symbolLimit: 10, compliant: true },
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:00.000Z",
});

async function fillAndSubmit() {
  await waitFor(() => expect(screen.getByTestId("monitor-form")).toBeDefined());
  await userEvent.type(screen.getByLabelText("Name"), "Second watch");
  await userEvent.selectOptions(
    screen.getByLabelText("Strategy"),
    "strategy-1",
  );
  await userEvent.selectOptions(screen.getByLabelText("Stock list"), "list-1");
  await userEvent.click(screen.getByTestId("submit-monitor"));
}

beforeEach(() => {
  createMonitorMock.mockReset();
  vi.mocked(fetchStrategies)
    .mockReset()
    .mockResolvedValue([strategy("strategy-1")]);
  vi.mocked(fetchStockLists)
    .mockReset()
    .mockResolvedValue([list("list-1")]);
});

describe("MonitorFormDialog at the active-monitor limit", () => {
  it("starts switched off and says why, so the save succeeds", async () => {
    createMonitorMock.mockResolvedValue({
      enabled: false,
    } as MonitorDetailResponse);
    render(
      <MonitorFormDialog
        mode="create"
        activeCount={1}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("monitor-form")).toBeDefined(),
    );

    expect(
      (screen.getByLabelText(/Start monitoring now/) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByTestId("monitor-capacity-hint").textContent).toContain(
      "Free allows 1 active monitor",
    );

    await fillAndSubmit();
    await waitFor(() =>
      expect(createMonitorMock).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      ),
    );
  });

  it("starts switched on below the limit", async () => {
    render(
      <MonitorFormDialog
        mode="create"
        activeCount={0}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("monitor-form")).toBeDefined(),
    );
    expect(
      (screen.getByLabelText(/Start monitoring now/) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.queryByTestId("monitor-capacity-hint")).toBeNull();
  });

  it("turns a capacity refusal into 'Save without monitoring'", async () => {
    const onSaved = vi.fn();
    createMonitorMock
      .mockRejectedValueOnce(
        new ApiError(
          403,
          "Your plan allows 1 active monitor; you already have 1",
          "ENTITLEMENT_MONITOR_LIMIT",
        ),
      )
      .mockResolvedValueOnce({ enabled: false } as MonitorDetailResponse);
    // The count the page knew was stale (another tab enabled one), so the dialog offered "on".
    render(
      <MonitorFormDialog
        mode="create"
        activeCount={0}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );
    await fillAndSubmit();

    const refusal = await screen.findByTestId("monitor-form-error");
    expect(refusal.textContent).toContain("Your plan allows 1 active monitor");
    expect(refusal.querySelector('a[href="/billing"]')).not.toBeNull();

    await userEvent.click(
      screen.getByTestId("monitor-save-without-monitoring"),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createMonitorMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});
