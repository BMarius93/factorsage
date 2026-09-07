import type { StrategySummaryResponse } from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStrategy,
  fetchStrategies,
  updateStrategy,
} from "../api/strategies-api";
import { StrategiesPage } from "./StrategiesPage";

vi.mock("../api/strategies-api", () => ({
  fetchStrategies: vi.fn(),
  updateStrategy: vi.fn(),
  deleteStrategy: vi.fn(),
}));

const fetchStrategiesMock = vi.mocked(fetchStrategies);
const updateStrategyMock = vi.mocked(updateStrategy);
const deleteStrategyMock = vi.mocked(deleteStrategy);

function summary(
  id: string,
  name: string,
  overrides: Partial<StrategySummaryResponse> = {},
): StrategySummaryResponse {
  return {
    id,
    name,
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fetchStrategiesMock.mockReset();
  updateStrategyMock.mockReset();
  deleteStrategyMock.mockReset();
});

describe("StrategiesPage", () => {
  it("offers the builder as the only way to create, because a name alone is not a strategy", async () => {
    fetchStrategiesMock.mockResolvedValue([]);
    render(<StrategiesPage />);

    const link = await screen.findByTestId("new-strategy-button");
    expect(link).toHaveProperty("tagName", "A");
    expect(link.getAttribute("href")).toBe("/strategies/new");
    expect(screen.getByTestId("strategies-empty")).toBeDefined();
  });

  it("renders each strategy's shape from its summary counts alone", async () => {
    fetchStrategiesMock.mockResolvedValue([
      summary("s1", "Deep value", {
        description: "Buy the discount",
        sellLevelCount: 2,
        hasFinalExit: true,
      }),
      summary("s2", "Trend"),
    ]);
    render(<StrategiesPage />);

    expect(await screen.findByText("Deep value")).toBeDefined();
    expect(screen.getByText("1 buy · 2 sells · final exit")).toBeDefined();
    expect(screen.getByText("1 buy")).toBeDefined();
    expect(screen.getByText("Buy the discount")).toBeDefined();
    // The collection never loads a definition.
    expect(fetchStrategiesMock).toHaveBeenCalledTimes(1);
  });

  it("links each card to its builder", async () => {
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Deep value")]);
    render(<StrategiesPage />);

    const link = await screen.findByRole("link", { name: /Deep value/ });
    expect(link.getAttribute("href")).toBe("/strategies/s1");
  });

  it("renames a strategy without touching its definition", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Old name")]);
    updateStrategyMock.mockResolvedValue(summary("s1", "New name"));
    render(<StrategiesPage />);

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "New name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateStrategyMock).toHaveBeenCalledWith("s1", {
        name: "New name",
        description: null,
      });
    });
    expect(await screen.findByText("New name")).toBeDefined();
  });

  it("deletes a strategy only after confirmation", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockResolvedValue([summary("s1", "Doomed")]);
    deleteStrategyMock.mockResolvedValue();
    render(<StrategiesPage />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteStrategyMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete strategy" }));
    await waitFor(() => expect(deleteStrategyMock).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByText("Doomed")).toBeNull());
  });

  it("offers a retry when the collection cannot be loaded", async () => {
    const user = userEvent.setup();
    fetchStrategiesMock.mockRejectedValueOnce(new Error("offline"));
    fetchStrategiesMock.mockResolvedValueOnce([summary("s1", "Recovered")]);
    render(<StrategiesPage />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered")).toBeDefined();
  });
});
