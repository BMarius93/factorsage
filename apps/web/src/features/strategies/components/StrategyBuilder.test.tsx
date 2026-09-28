import {
  STRATEGY_SCHEMA_VERSION,
  strategyMetricLabel,
  type StrategyCondition,
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

// The editor is only ever reached signed in; its header's account-dependent links need to know.
vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: {
      status: "authenticated",
      user: { id: "u1", email: "u@example.test", role: "USER", plan: "PRO" },
    },
    signOut: vi.fn(),
  }),
}));

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

/** Chooses a Metric the way a user does: its category first, then the metric within it. */
async function chooseMetric(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
  category: string,
  metric: string,
) {
  await user.selectOptions(
    within(row).getByTestId("metric-category-select"),
    category,
  );
  const select = within(row).getByTestId("metric-select") as HTMLSelectElement;
  if (select.value !== metric) {
    await user.selectOptions(select, metric);
  }
}

function optionTexts(select: HTMLElement): (string | null)[] {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
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
    // A pristine form reports nothing to fix: no red count before any interaction (UI-013).
    expect(screen.queryByTestId("issue-count")).toBeNull();
    expect(screen.getByText("Nothing to save yet")).toBeDefined();
  });

  it("adds every row on the first category's first metric, never on an empty one", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));

    // A complete rule: category, metric, condition and value, all chosen and all consistent.
    const category = screen.getByTestId(
      "metric-category-select",
    ) as HTMLSelectElement;
    const metric = screen.getByTestId("metric-select") as HTMLSelectElement;
    expect(category.value).toBe("PRICE");
    expect(metric.value).toBe("PRICE:");
    expect(metric.selectedOptions[0]?.textContent).toBe("Price");
    expect(
      (screen.getByTestId("operator-select") as HTMLSelectElement).value,
    ).toBe("IS_ABOVE");
    expect(
      (screen.getByTestId("value-control") as HTMLSelectElement).value,
    ).toBe("SMA_20D");
    const preview = within(screen.getByTestId("logic-preview"));
    expect(preview.getByText(/Price is above SMA 20D/)).toBeDefined();
    // The count stays neutral until the user engages; the missing name keeps the save closed.
    expect(screen.getByTestId("issue-count").getAttribute("data-tone")).toBe(
      "neutral",
    );
    expect(screen.getByTestId("save-strategy")).toHaveProperty("disabled", true);
  });

  it("moves through Category, Metric, Condition and Value in that order from the keyboard", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={savedStrategy()} />);
    const row = screen.getByTestId("predicate-row");
    await user.click(within(row).getByTestId("metric-category-select"));
    for (const next of ["metric-select", "operator-select", "value-control"]) {
      await user.tab();
      expect(document.activeElement).toBe(within(row).getByTestId(next));
    }
    expect(
      within(row)
        .getByTestId("metric-category-select")
        .getAttribute("aria-label"),
    ).toBe("Category");
    expect(
      within(row).getByTestId("metric-select").getAttribute("aria-label"),
    ).toBe("Metric");
  });

  it("makes removing a level with authored logic recoverable (UI-014)", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={savedStrategy()} />);

    await user.click(screen.getByRole("button", { name: "Remove BUY 1" }));
    expect(screen.queryAllByTestId("level-card-BUY")).toHaveLength(0);
    const undo = screen.getByTestId("strategy-undo");
    expect(undo.textContent).toContain("BUY 1 removed");
    await user.click(within(undo).getByRole("button", { name: "Undo" }));
    expect(screen.getAllByTestId("level-card-BUY")).toHaveLength(1);
    expect(screen.queryByTestId("strategy-undo")).toBeNull();
  });

  it("names an existing strategy in its header and offers its actions (UI-015)", async () => {
    render(<StrategyBuilder strategy={savedStrategy()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Deep value",
    );
    expect(
      screen.getByTestId("strategy-run-backtest").getAttribute("href"),
    ).toBe("/backtests/new?strategyId=s1");
    expect(
      screen.getByRole("button", { name: "More actions for Deep value" }),
    ).toBeDefined();
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
    await chooseMetric(
      user,
      screen.getByTestId("predicate-row"),
      "OSCILLATORS",
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
    await chooseMetric(
      user,
      screen.getByTestId("predicate-row"),
      "MOVING_AVERAGES",
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
    await chooseMetric(
      user,
      screen.getByTestId("predicate-row"),
      "OSCILLATORS",
      "OSCILLATOR:RSI_14D",
    );

    const value = screen.getByTestId("value-control");
    expect(value.getAttribute("type")).toBe("number");
    expect(value.getAttribute("min")).toBe("1");
    expect(value.getAttribute("max")).toBe("100");
    expect((value as HTMLInputElement).value).toBe("50");
  });

  it("offers no Position category in a BUY level, and Gain and Loss under it in a SELL level", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    expect(
      optionTexts(screen.getByTestId("metric-category-select")),
    ).not.toContain("Position");

    await user.click(screen.getByTestId("add-level-SELL"));
    const sellCard = screen.getByTestId("level-card-SELL");
    expect(
      optionTexts(within(sellCard).getByTestId("metric-category-select")),
    ).toContain("Position");
    await user.selectOptions(
      within(sellCard).getByTestId("metric-category-select"),
      "POSITION",
    );
    expect(optionTexts(within(sellCard).getByTestId("metric-select"))).toEqual([
      "Gain",
      "Loss",
    ]);
  });

  it("offers Relative Volume in a Signal's conditions, at the three fixed periods", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.selectOptions(
      screen.getByTestId("metric-category-select"),
      "VOLUME",
    );
    // Exactly three, in one category: no custom window, and no second volume indicator.
    expect(optionTexts(screen.getByTestId("metric-select"))).toEqual([
      "RVOL 10",
      "RVOL 20",
      "RVOL 50",
    ]);
  });

  it("authors an RVOL condition as a multiple, and describes it that way", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await chooseMetric(
      user,
      screen.getByTestId("predicate-row"),
      "VOLUME",
      "RELATIVE_VOLUME:20",
    );

    // The value control is a number carrying the multiple's own domain and unit.
    const value = screen.getByTestId("value-control");
    expect(value.getAttribute("type")).toBe("number");
    expect(value.getAttribute("min")).toBe("0");
    expect(value.getAttribute("max")).toBeNull();
    expect((value as HTMLInputElement).value).toBe("1");

    await user.clear(value);
    await user.type(value, "2");
    expect(
      within(screen.getByTestId("logic-preview")).getByText(
        /RVOL 20 is above 2\.0x/,
      ),
    ).toBeDefined();
  });

  it("never offers Relative Volume as a Trigger (regression)", async () => {
    // RVOL is a Condition-only metric: a Monitor's not-matched -> matched transition already
    // turns `RVOL 20 is above 2.0x` into a Signal, so a crossing operator would be a second way
    // to say the same thing. The registry decides this; the control just follows it.
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-trigger"));

    const categories = screen.getAllByTestId("metric-category-select");
    // The last row is the Trigger; the first is the Condition it was added beside. The condition-only
    // families — Volume and both alternative-data categories — are simply not offered to a Trigger.
    expect(optionTexts(categories.at(-1)!)).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Valuation",
    ]);
    // …and the Condition row above it still offers Volume, so this is a part rule.
    expect(optionTexts(categories[0]!)).toContain("Volume");
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
    // Both rows start as the same complete rule, so the second repeats the first until edited.
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

  it("reports a repeated condition once any field of that row is touched, not before", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));
    const [first, second] = screen.getAllByTestId("predicate-row");
    // Nothing the user wrote is wrong yet: the repeat is the default rule, not their logic.
    expect(screen.queryByText(/repeats condition 1/)).toBeNull();

    // Touching the first row says nothing about the second.
    await user.click(within(first!).getByTestId("operator-select"));
    await user.tab();
    expect(screen.queryByText(/repeats condition 1/)).toBeNull();

    // The issue belongs to the row rather than to one field, so any of its fields reveals it.
    await user.click(within(second!).getByTestId("operator-select"));
    await user.tab();
    expect(within(second!).getByRole("alert").textContent).toMatch(
      /repeats condition 1/,
    );
    expect(within(first!).queryByRole("alert")).toBeNull();
  });

  it("keeps explaining the focused rule when a rule before it is removed", async () => {
    const user = userEvent.setup();
    const rsi: StrategyCondition = {
      id: "c2",
      metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      operator: "IS_BELOW",
      value: { kind: "NUMBER", value: 30 },
    };
    const saved = savedStrategy();
    render(
      <StrategyBuilder
        strategy={{
          ...saved,
          definition: {
            ...saved.definition,
            buyLevels: [
              {
                id: "buy-1",
                percentage: 25,
                signal: {
                  conditions: [
                    saved.definition.buyLevels[0]!.signal.conditions[0]!,
                    rsi,
                    {
                      id: "c3",
                      metric: { kind: "RELATIVE_VOLUME", period: 20 },
                      operator: "IS_ABOVE",
                      value: { kind: "MULTIPLE", value: 2 },
                    },
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    const explained = () =>
      within(screen.getByTestId("explanation-panel")).getByRole("heading")
        .textContent;

    await user.click(
      within(screen.getAllByTestId("predicate-row")[1]!).getByTestId(
        "metric-select",
      ),
    );
    expect(explained()).toBe(strategyMetricLabel(rsi.metric));

    await user.click(
      screen.getByRole("button", { name: "Remove condition 1" }),
    );
    const [moved, last] = screen.getAllByTestId("predicate-row");
    // The explanation follows the rule into its new position; it never passes to the rule that
    // now holds the old one.
    expect(explained()).toBe(strategyMetricLabel(rsi.metric));
    expect(within(moved!).queryByTestId("inline-help")).not.toBeNull();
    expect(within(last!).queryByTestId("inline-help")).toBeNull();
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
    await chooseMetric(
      user,
      screen.getAllByTestId("predicate-row").at(-1)!,
      "OSCILLATORS",
      "OSCILLATOR:RSI_14D",
    );
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

  it("gives a BUY or SELL header a name, a size and Remove, and no reordering arrows", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-SELL"));
    await user.click(screen.getByTestId("add-level-SELL"));

    // Two levels of each kind: the width at which ↑/↓ used to become enabled, so a header that
    // still rendered them could not hide behind a disabled state.
    for (const levelKind of ["BUY", "SELL"] as const) {
      for (const card of screen.getAllByTestId(`level-card-${levelKind}`)) {
        expect(
          within(card).queryByRole("button", { name: /^Move / }),
        ).toBeNull();
        expect(within(card).queryByText("↑")).toBeNull();
        expect(within(card).queryByText("↓")).toBeNull();
      }
    }
    // The header still carries what it is for. Ordering itself is untouched — the `moveLevel`
    // action and its reducer behaviour are covered by `strategy-draft.test.ts`; only the control
    // is out of the UI for now.
    expect(
      screen.getAllByRole("button", { name: "Remove BUY 2" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Remove SELL 2" }),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("level-percentage").length).toBe(4);
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
      "+ Add exit rule",
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
    expect(preview.getByText("Exit rule 1")).toBeTruthy();
    expect(preview.getByText("Exit rule 2")).toBeTruthy();
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
