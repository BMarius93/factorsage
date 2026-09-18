import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardNavigation } from "../../../components/layout/unsaved-changes";
import {
  entitlementRefusal,
  rateLimited,
  RATE_LIMITED_COPY,
  unexpectedFailure,
} from "../../../lib/api/__testing__/request-failures";
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
    ownership: "USER",
    canEdit: true,
    id: "s1",
    name: "Deep value",
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
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

/** Stands in for a click on a shell navigation link, which is what the guard intercepts. */
function navigateAway() {
  const event = { preventDefault: vi.fn() };
  guardNavigation(event);
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("keeps the draft on the page when the user cancels leaving it", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StrategyBuilder />);

    await user.type(screen.getByLabelText("Name"), "Deep value");
    await user.click(screen.getByTestId("add-level-BUY"));

    expect(navigateAway().preventDefault).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Staying keeps the draft exactly as it was; nothing is stashed or reloaded.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Deep value");
    expect(screen.getAllByTestId("level-card-BUY")).toHaveLength(1);
    expect(screen.getByText("Unsaved changes")).toBeDefined();
  });

  it("lets the user leave and discard the draft once they confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StrategyBuilder />);

    await user.type(screen.getByLabelText("Name"), "Deep value");

    expect(navigateAway().preventDefault).not.toHaveBeenCalled();
  });

  it("never asks when there is nothing unsaved", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StrategyBuilder strategy={savedStrategy()} />);

    expect(navigateAway().preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("never asks again once the strategy has been saved", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    createStrategyMock.mockResolvedValue(savedStrategy());
    render(<StrategyBuilder />);

    await user.type(screen.getByLabelText("Name"), "Deep value");
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("save-strategy"));
    await screen.findByText("All changes saved");

    expect(navigateAway().preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
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

/**
 * FINAL EXIT in the Builder: one card, alternatives inside it, and an unmissable OR.
 *
 * The specific misreading this guards against is a reader seeing several Final Exits in sequence.
 * So the card count stays one, the rule headings and the OR divider only appear when there is a
 * genuine alternative to label, and the Strategy Logic panel says the same thing in words.
 */
describe("StrategyBuilder final exit rules", () => {
  function exitCard() {
    return within(screen.getByTestId("level-card-FINAL_EXIT"));
  }

  async function builderWithFinalExit() {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-FINAL_EXIT"));
    return user;
  }

  it("opens FINAL EXIT with one rule, no rule heading and no OR", async () => {
    await builderWithFinalExit();

    expect(screen.getAllByTestId("level-card-FINAL_EXIT")).toHaveLength(1);
    expect(exitCard().getAllByTestId("exit-rule")).toHaveLength(1);
    expect(exitCard().queryByTestId("exit-rule-or")).toBeNull();
    expect(exitCard().queryByText("Exit rule 1")).toBeNull();
    // The control that makes the alternative reachable is there from the start.
    expect(exitCard().getByTestId("add-exit-rule").textContent).toBe(
      "+ Add OR rule",
    );
  });

  it("adds a second rule, labels both and draws the OR between them", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));

    // Still one FINAL EXIT card: the rules are alternatives inside it, not more Final Exits.
    expect(screen.getAllByTestId("level-card-FINAL_EXIT")).toHaveLength(1);
    expect(exitCard().getAllByTestId("exit-rule")).toHaveLength(2);
    expect(exitCard().getByText("Exit rule 1")).toBeTruthy();
    expect(exitCard().getByText("Exit rule 2")).toBeTruthy();
    // Exactly one divider: between the two rules, never before the first.
    const dividers = exitCard().getAllByTestId("exit-rule-or");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.textContent).toBe("OR");
  });

  it("adds a third rule and numbers all three", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    await user.click(exitCard().getByTestId("add-exit-rule"));

    expect(exitCard().getAllByTestId("exit-rule")).toHaveLength(3);
    expect(exitCard().getAllByTestId("exit-rule-or")).toHaveLength(2);
    expect(exitCard().getByText("Exit rule 3")).toBeTruthy();
  });

  it("renumbers after the middle rule is removed", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    await user.click(exitCard().getByTestId("add-exit-rule"));

    // Give rule 3 a recognisable edit, so renumbering can be told from reordering.
    const thirdRule = within(exitCard().getAllByTestId("exit-rule")[2] as HTMLElement);
    await user.click(thirdRule.getByTestId("add-condition"));
    expect(thirdRule.getAllByTestId("predicate-row")).toHaveLength(2);

    await user.click(
      exitCard().getByRole("button", { name: "Remove exit rule 2" }),
    );

    const remaining = exitCard().getAllByTestId("exit-rule");
    expect(remaining).toHaveLength(2);
    expect(exitCard().getByText("Exit rule 2")).toBeTruthy();
    expect(exitCard().queryByText("Exit rule 3")).toBeNull();
    // The rule that was third is now second, carrying its own two conditions with it.
    expect(
      within(remaining[1] as HTMLElement).getAllByTestId("predicate-row"),
    ).toHaveLength(2);
  });

  it("drops the headings and the OR again once one rule is left", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    await user.click(
      exitCard().getByRole("button", { name: "Remove exit rule 2" }),
    );

    expect(exitCard().getAllByTestId("exit-rule")).toHaveLength(1);
    expect(exitCard().queryByTestId("exit-rule-or")).toBeNull();
    expect(exitCard().queryByText("Exit rule 1")).toBeNull();
  });

  it("lets the first rule be removed once there are two", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));

    expect(
      exitCard().getByRole("button", { name: "Remove exit rule 1" }),
    ).toBeTruthy();
    await user.click(
      exitCard().getByRole("button", { name: "Remove exit rule 1" }),
    );
    expect(exitCard().getAllByTestId("exit-rule")).toHaveLength(1);
    // FINAL EXIT itself survives: only one of its alternatives went.
    expect(screen.getAllByTestId("level-card-FINAL_EXIT")).toHaveLength(1);
  });

  it("shows the OR structure in the Strategy Logic panel", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    // Make rule 2 different, so the document is valid and the preview reads distinctly.
    const secondRule = within(exitCard().getAllByTestId("exit-rule")[1] as HTMLElement);
    await user.selectOptions(
      secondRule.getAllByTestId("operator-select")[0] as HTMLElement,
      "IS_BELOW",
    );

    const preview = within(screen.getByTestId("logic-preview"));
    expect(preview.getByText("Rule 1")).toBeTruthy();
    expect(preview.getByText("Rule 2")).toBeTruthy();
    expect(preview.getAllByTestId("preview-exit-rule-or")).toHaveLength(1);
    // One FINAL EXIT heading, not one per rule.
    expect(preview.getAllByText("FINAL EXIT")).toHaveLength(1);
  });

  it("reports an empty rule against that rule and blocks the save", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    const secondRule = within(exitCard().getAllByTestId("exit-rule")[1] as HTMLElement);
    await user.click(
      secondRule.getByRole("button", { name: "Remove condition 1" }),
    );

    await user.click(screen.getByTestId("issue-count"));
    expect(
      within(exitCard().getAllByTestId("exit-rule")[1] as HTMLElement).getByRole(
        "alert",
      ).textContent,
    ).toMatch(/at least one condition or a trigger/i);
    expect(screen.getByTestId("save-strategy")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("saves both rules, in order", async () => {
    const user = await builderWithFinalExit();
    await user.click(exitCard().getByTestId("add-exit-rule"));
    const secondRule = within(exitCard().getAllByTestId("exit-rule")[1] as HTMLElement);
    await user.selectOptions(
      secondRule.getAllByTestId("operator-select")[0] as HTMLElement,
      "IS_BELOW",
    );
    await user.type(screen.getByLabelText("Name"), "Two ways out");

    createStrategyMock.mockResolvedValue({
      ...savedStrategy(),
      name: "Two ways out",
    });
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(createStrategyMock).toHaveBeenCalled());
    const sent = createStrategyMock.mock.calls[0]?.[0];
    const rules = sent?.definition.finalExit?.rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[0]?.signal.conditions[0]?.operator).toBe("IS_ABOVE");
    expect(rules[1]?.signal.conditions[0]?.operator).toBe("IS_BELOW");
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(2);
  });
});

describe("StrategyBuilder save refusals (UX-001)", () => {
  async function saveRenameWith(error: unknown) {
    const user = userEvent.setup();
    updateStrategyMock.mockRejectedValue(error);
    render(<StrategyBuilder strategy={savedStrategy()} />);
    await user.type(screen.getByLabelText("Name"), " 2");
    await user.click(screen.getByTestId("save-strategy"));
    return (await screen.findByRole("alert")).textContent;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a plan refusal in the API's words", async () => {
    expect(
      await saveRenameWith(
        entitlementRefusal(
          "ENTITLEMENT_FEATURE_UNAVAILABLE",
          "Your plan does not include this.",
        ),
      ),
    ).toBe("Your plan does not include this.");
  });

  it("reads a 429 as a wait", async () => {
    expect(await saveRenameWith(rateLimited())).toBe(RATE_LIMITED_COPY);
  });

  it("keeps its own fallback for anything unexpected", async () => {
    expect(await saveRenameWith(unexpectedFailure())).toBe(
      "The strategy could not be saved right now. Try again in a moment.",
    );
  });
});
