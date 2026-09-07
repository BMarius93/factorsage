import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStrategy,
  replaceStrategyDefinition,
  updateStrategy,
} from "../api/strategies-api";
import { StrategyBuilder } from "./StrategyBuilder";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock("../api/strategies-api", async () => {
  const actual = await vi.importActual<typeof import("../api/strategies-api")>(
    "../api/strategies-api",
  );
  return {
    ...actual,
    createStrategy: vi.fn(),
    updateStrategy: vi.fn(),
    replaceStrategyDefinition: vi.fn(),
  };
});

const createStrategyMock = vi.mocked(createStrategy);
const updateStrategyMock = vi.mocked(updateStrategy);
const replaceDefinitionMock = vi.mocked(replaceStrategyDefinition);

function savedStrategy(): StrategyDetailResponse {
  return {
    id: "s1",
    name: "Deep value",
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    definition: {
      schemaVersion: 1,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 25,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: { kind: "PRICE" },
                operator: "IS_ABOVE",
                value: { kind: "SERIES", seriesId: "EMA_200D" },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    },
  };
}

beforeEach(() => {
  replace.mockReset();
  createStrategyMock.mockReset();
  updateStrategyMock.mockReset();
  replaceDefinitionMock.mockReset();
});

describe("StrategyBuilder", () => {
  it("opens a new strategy without a wall of red, and cannot be saved yet", async () => {
    render(<StrategyBuilder />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("save-strategy")).toHaveProperty(
      "disabled",
      true,
    );
    // A strategy with no BUY level can never buy anything, so the issue count is non-zero.
    expect(screen.getByTestId("issue-count").textContent).toMatch(
      /issues to fix/,
    );
  });

  it("reveals a field's issue only once that field is touched", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);

    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBeNull();
    await user.click(name);
    await user.tab();
    expect(await screen.findByText(/A strategy needs a name/)).toBeDefined();
  });

  it("offers only the operators the selected metric supports", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));

    const operator = screen.getByTestId("operator-select");
    const priceOptions = within(operator)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(priceOptions).toEqual(["is above", "is below", "is close to"]);

    // RSI does not expose `is close to` in V1.
    await user.selectOptions(
      screen.getByTestId("metric-select"),
      "OSCILLATOR:RSI_14D",
    );
    expect(
      within(screen.getByTestId("operator-select"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["is above", "is below"]);
  });

  it("offers a moving-average metric only same-timeframe comparisons, never itself", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.selectOptions(
      screen.getByTestId("metric-select"),
      "MOVING_AVERAGE:SMA_50D",
    );

    const values = within(screen.getByTestId("value-control"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(values).toContain("SMA 200D");
    expect(values).not.toContain("SMA 50D");
    expect(values.some((label) => label?.endsWith("W"))).toBe(false);
    expect(values.some((label) => label?.startsWith("RSI"))).toBe(false);
  });

  it("swaps the value control to a bounded number for RSI", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.selectOptions(
      screen.getByTestId("metric-select"),
      "OSCILLATOR:RSI_14D",
    );

    const value = screen.getByTestId("value-control");
    expect(value.getAttribute("type")).toBe("number");
    expect(value.getAttribute("min")).toBe("1");
    expect(value.getAttribute("max")).toBe("100");
    expect((value as HTMLInputElement).value).toBe("50");
  });

  it("offers no Gain or Loss metric in a BUY level, and both in a SELL level", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const buyMetrics = within(screen.getByTestId("metric-select"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(buyMetrics).not.toContain("Gain");
    expect(buyMetrics).not.toContain("Loss");

    await user.click(screen.getByTestId("add-level-SELL"));
    const sellCard = screen.getByTestId("level-card-SELL");
    const sellMetrics = within(within(sellCard).getByTestId("metric-select"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(sellMetrics).toContain("Gain");
    expect(sellMetrics).toContain("Loss");
  });

  it("shows a percentage control on BUY and SELL levels and none on FINAL EXIT", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-FINAL_EXIT"));

    expect(
      within(screen.getByTestId("level-card-BUY")).getByTestId(
        "level-percentage",
      ),
    ).toBeDefined();
    expect(
      within(screen.getByTestId("level-card-FINAL_EXIT")).queryByTestId(
        "level-percentage",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId("level-card-BUY"))
        .getAllByRole("radio")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["25", "50", "75", "100"]);
  });

  it("keeps a duplicate condition and reports it rather than silently removing it", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));

    // Both rows default to the same metric, operator and value.
    expect(screen.getAllByTestId("predicate-row")).toHaveLength(2);
    // Save stays disabled, so the issue count is the way to see what is wrong.
    expect(screen.getByTestId("save-strategy")).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(screen.getByTestId("issue-count"));
    expect(await screen.findByText(/repeats condition 1/)).toBeDefined();
    expect(screen.getAllByTestId("predicate-row")).toHaveLength(2);
  });

  it("saves a valid new strategy and routes to its own page", async () => {
    const user = userEvent.setup();
    createStrategyMock.mockResolvedValue(savedStrategy());
    render(<StrategyBuilder />);

    await user.type(screen.getByLabelText("Name"), "Deep value");
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(createStrategyMock).toHaveBeenCalledTimes(1));
    const payload = createStrategyMock.mock.calls[0]?.[0];
    expect(payload?.name).toBe("Deep value");
    expect(payload?.definition.buyLevels).toHaveLength(1);
    expect(replace).toHaveBeenCalledWith("/strategies/s1");
  });

  it("never autosaves", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={savedStrategy()} />);
    await user.click(screen.getByTestId("add-condition"));
    await user.type(screen.getByLabelText("Name"), "!");
    expect(updateStrategyMock).not.toHaveBeenCalled();
    expect(replaceDefinitionMock).not.toHaveBeenCalled();
  });

  it("saves a rename without touching the definition", async () => {
    const user = userEvent.setup();
    const strategy = savedStrategy();
    updateStrategyMock.mockResolvedValue({
      ...strategy,
      name: "Deep value 2",
    });
    render(<StrategyBuilder strategy={strategy} />);

    await user.type(screen.getByLabelText("Name"), " 2");
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(updateStrategyMock).toHaveBeenCalledTimes(1));
    expect(replaceDefinitionMock).not.toHaveBeenCalled();
  });

  it("saves a definition change without renaming", async () => {
    const user = userEvent.setup();
    const strategy = savedStrategy();
    replaceDefinitionMock.mockResolvedValue(strategy);
    render(<StrategyBuilder strategy={strategy} />);

    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalledTimes(1));
    expect(updateStrategyMock).not.toHaveBeenCalled();
    expect(replaceDefinitionMock.mock.calls[0]?.[1].buyLevels).toHaveLength(2);
  });

  it("discards changes back to the saved strategy", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={savedStrategy()} />);

    await user.click(screen.getByTestId("add-level-BUY"));
    expect(screen.getAllByTestId("level-card-BUY")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getAllByTestId("level-card-BUY")).toHaveLength(1);
  });

  it("offers no control for anything that belongs to a backtest", () => {
    render(<StrategyBuilder strategy={savedStrategy()} />);
    // Asserted against form controls, not prose: the page copy legitimately mentions that capital
    // and stock selection belong to a backtest.
    for (const forbidden of [
      /stock list/i,
      /capital/i,
      /contribution/i,
      /maximum positions/i,
      /date range/i,
      /fee/i,
    ]) {
      expect(screen.queryByLabelText(forbidden)).toBeNull();
      expect(screen.queryByPlaceholderText(forbidden)).toBeNull();
    }
  });
});
