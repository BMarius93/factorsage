import {
  STRATEGY_SCHEMA_VERSION,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchActorGroups,
  resolveActors,
  searchActors,
} from "../../alternative-data/api/alternative-data-api";
import { replaceStrategyDefinition } from "../api/strategies-api";
import { StrategyBuilder } from "./StrategyBuilder";

/**
 * The alternative-data half of the Strategy Builder.
 *
 * What it proves is the rule the Category / Metric selector exists for: a metric's **identity** —
 * its category and its measure — is what the two selectors show, and its **configuration** — the
 * lookback, the scope, the filters — is edited in its own dialog and rendered by one canonical
 * summary. The row, the Strategy Logic sidebar, the explanation panel, the saved document and a
 * reloaded Builder must all agree on it; the selector once said `20D` while everything else said
 * `180D`. It also covers the phone layout's grammar, because responsive behaviour is part of
 * acceptance rather than a later cleanup.
 */

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
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("../api/strategies-api", async () => {
  const actual = await vi.importActual<typeof import("../api/strategies-api")>(
    "../api/strategies-api",
  );
  return { ...actual, replaceStrategyDefinition: vi.fn() };
});

vi.mock("../../alternative-data/api/alternative-data-api", () => ({
  searchActors: vi.fn(),
  resolveActors: vi.fn(),
  fetchActorGroups: vi.fn(),
}));

const replaceDefinitionMock = vi.mocked(replaceStrategyDefinition);
const searchActorsMock = vi.mocked(searchActors);
const resolveActorsMock = vi.mocked(resolveActors);
const fetchActorGroupsMock = vi.mocked(fetchActorGroups);

const LEADERSHIP: ActorGroupSummaryResponse = {
  ownership: "USER",
  canEdit: true,
  id: "group-1",
  name: "House leadership",
  memberCount: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PELOSI: AlternativeDataActorResponse = {
  id: "actor-1",
  externalId: "P000197",
  displayName: "Nancy Pelosi",
  chamber: "HOUSE",
  state: "CA",
  district: "CA11",
};

function strategyWith(
  name: string,
  condition: StrategyDefinition["buyLevels"][number]["signal"]["conditions"][number],
): StrategyDetailResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id: "s1",
    name,
    buyLevelCount: 1,
    sellLevelCount: 0,
    hasFinalExit: false,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        { id: "buy-1", percentage: 100, signal: { conditions: [condition] } },
      ],
      sellLevels: [],
    },
  };
}

/** A saved strategy whose only condition is a congressional one scoped to a group. */
function congressStrategy(): StrategyDetailResponse {
  return strategyWith("Follow the Hill", {
    id: "c1",
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "BUYERS",
      lookback: 60,
      scope: { kind: "GROUP", groupId: "group-1" },
      chamber: "ANY",
    },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value: 2 },
  });
}

/** An insider strategy, which has no actor scope at all in V1. */
function insiderStrategy(): StrategyDetailResponse {
  return strategyWith("Insiders buying", {
    id: "c1",
    metric: { kind: "INSIDER_ACTIVITY", measure: "BUYERS", lookback: 20 },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value: 1 },
  });
}

function priceStrategy(): StrategyDetailResponse {
  return strategyWith("Below the average", {
    id: "c1",
    metric: { kind: "PRICE" },
    operator: "IS_BELOW",
    value: { kind: "SERIES", seriesId: "SMA_200D" },
  });
}

function selectIn(row: HTMLElement, testId: string): HTMLSelectElement {
  return within(row).getByTestId(testId) as HTMLSelectElement;
}

/** The text a select shows: its selected option, not its value. */
function shown(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent ?? "";
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent ?? "");
}

/** Every place the Builder describes the row's metric, read at once. */
function representations() {
  const row = screen.getByTestId("predicate-row");
  const side = screen.getByTestId("explanation-panel");
  return {
    category: selectIn(row, "metric-category-select"),
    metric: selectIn(row, "metric-select"),
    summary:
      within(row).queryByTestId("operand-configuration-summary")?.textContent ??
      null,
    configureLabel: within(row)
      .getByTestId("operand-config-button")
      .getAttribute("aria-label"),
    logic: within(screen.getByTestId("logic-preview"))
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim()),
    helpTitle: within(side).getByRole("heading").textContent,
    helpCategory: within(side).queryByTestId("help-category")?.textContent,
    helpConfiguration:
      within(side).queryByTestId("help-configuration")?.textContent ?? null,
  };
}

async function configure(
  user: ReturnType<typeof userEvent.setup>,
  change: (dialog: HTMLElement) => Promise<void>,
): Promise<void> {
  await user.click(screen.getByTestId("operand-config-button"));
  const dialog = await screen.findByTestId("alternative-data-config");
  await change(dialog);
  await user.click(within(dialog).getByTestId("alternative-data-config-apply"));
  await waitFor(() =>
    expect(screen.queryByTestId("alternative-data-config")).toBeNull(),
  );
}

beforeEach(() => {
  searchActorsMock.mockResolvedValue([PELOSI]);
  resolveActorsMock.mockResolvedValue([]);
  fetchActorGroupsMock.mockResolvedValue([LEADERSHIP]);
  replaceDefinitionMock.mockImplementation(async (_id, definition) => ({
    ...congressStrategy(),
    definition,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the alternative-data condition row", () => {
  it("reads Category, Metric, Condition and Value, and puts configuration on its own line", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");

    expect(within(row).getAllByTestId("metric-category-select")).toHaveLength(
      1,
    );
    expect(within(row).getAllByTestId("metric-select")).toHaveLength(1);
    expect(within(row).getAllByTestId("operator-select")).toHaveLength(1);
    expect(within(row).getAllByTestId("value-control")).toHaveLength(1);
    expect(within(row).getByTestId("operand-config-button")).toBeDefined();

    expect(shown(selectIn(row, "metric-category-select"))).toBe(
      "Congressional trading",
    );
    expect(shown(selectIn(row, "metric-select"))).toBe("Congress buyers");
    expect(selectIn(row, "operator-select").value).toBe("IS_ABOVE");
    expect(
      (within(row).getByLabelText("Value") as HTMLInputElement).value,
    ).toBe("2");
  });

  it("names the metric by its identity alone, never by a configuration", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    const metric = selectIn(row, "metric-select");
    expect(metric.getAttribute("title")).toBe("Congress buyers");
    for (const label of optionLabels(metric)) {
      expect(label).not.toMatch(/\d+D\b/);
    }
  });

  it("summarizes the lookback and the group on the row and on the Strategy Logic line", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · House leadership"),
    );
    expect(representations().logic).toContain(
      "Congress buyers is above 2 (60D · House leadership)",
    );
  });

  it("falls back to a neutral label when the group's name cannot be resolved", async () => {
    // A deleted group, or a failed request: the identifier is the identity and nothing invents a name.
    fetchActorGroupsMock.mockRejectedValue(new Error("offline"));
    render(<StrategyBuilder strategy={congressStrategy()} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · Selected group"),
    );
  });

  it("always shows the lookback, because it is configuration rather than part of the name", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(
      within(row).getByTestId("operand-configuration-summary").textContent,
    ).toBe("20D");
    // Read with the Metric control, not only as a line below it.
    const summaryId = within(row)
      .getByTestId("operand-configuration-summary")
      .getAttribute("id");
    expect(
      selectIn(row, "metric-select").getAttribute("aria-describedby"),
    ).toContain(summaryId);
  });

  it("offers no configuration at all on a row with no alternative-data metric", async () => {
    render(<StrategyBuilder strategy={priceStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
    expect(
      within(row).queryByTestId("operand-configuration-summary"),
    ).toBeNull();
  });

  it("compares only with `is above` and `is below`", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    const operator = selectIn(row, "operator-select");
    expect([...operator.options].map((option) => option.value)).toEqual([
      "IS_ABOVE",
      "IS_BELOW",
    ]);
    expect(optionLabels(operator)).toEqual(["is above", "is below"]);
  });
});

describe("identity and configuration agree everywhere", () => {
  it("A: Insider activity -> Insider sellers configured to 180D reads 180D everywhere, saved and reloaded", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <StrategyBuilder strategy={insiderStrategy()} />,
    );
    const row = await screen.findByTestId("predicate-row");

    await user.selectOptions(
      selectIn(row, "metric-select"),
      "INSIDER_ACTIVITY:SELLERS",
    );
    await user.click(screen.getByTestId("operand-config-button"));
    let dialog = await screen.findByTestId("alternative-data-config");
    // The dialog names the metric it configures, and keeps naming it while the lookback changes.
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Configure Insider sellers",
    );
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "180");
    await user.click(within(dialog).getByRole("checkbox", { name: "CFO" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Configure Insider sellers",
    );
    await user.click(
      within(dialog).getByTestId("alternative-data-config-apply"),
    );

    const expectEverywhere180 = () => {
      const view = representations();
      expect(view.category.value).toBe("INSIDER_ACTIVITY");
      expect(shown(view.category)).toBe("Insider activity");
      expect(view.metric.value).toBe("INSIDER_ACTIVITY:SELLERS");
      expect(shown(view.metric)).toBe("Insider sellers");
      expect(view.summary).toBe("180D · CEO, CFO");
      expect(view.configureLabel).toBe("Configure Insider sellers");
      expect(view.logic).toContain(
        "Insider sellers is above 1 (180D · CEO, CFO)",
      );
      expect(view.helpTitle).toBe("Insider sellers");
      expect(view.helpCategory).toBe("Insider activity");
      expect(view.helpConfiguration).toBe("180D · CEO, CFO");
      // No surface still carries the default lookback it was chosen with.
      expect(screen.getByTestId("strategy-builder").textContent).not.toContain(
        "20D",
      );
    };
    await waitFor(() =>
      expect(representations().summary).toBe("180D · CEO, CFO"),
    );
    expectEverywhere180();

    // Reopening the dialog shows the configuration it was given.
    await user.click(screen.getByTestId("operand-config-button"));
    dialog = await screen.findByTestId("alternative-data-config");
    expect(
      (within(dialog).getByLabelText("Lookback") as HTMLSelectElement).value,
    ).toBe("180");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(saved?.buyLevels[0]?.signal.conditions[0]).toEqual({
      id: "c1",
      metric: {
        kind: "INSIDER_ACTIVITY",
        measure: "SELLERS",
        lookback: 180,
        roles: ["CEO", "CFO"],
      },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 1 },
    });

    // Reload: a new Builder over what was saved reconstructs exactly the same state.
    unmount();
    render(
      <StrategyBuilder
        strategy={{
          ...insiderStrategy(),
          definition: saved as StrategyDefinition,
        }}
      />,
    );
    await screen.findByTestId("predicate-row");
    await user.click(screen.getByTestId("metric-select"));
    expectEverywhere180();
  });

  it("B: Congressional trading -> Congress purchases configured to 180D + House agrees everywhere, saved and reloaded", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <StrategyBuilder strategy={congressStrategy()} />,
    );
    const row = await screen.findByTestId("predicate-row");
    await waitFor(() =>
      expect(representations().summary).toBe("60D · House leadership"),
    );

    // A different measure starts at its own default configuration: the group scope does not follow.
    await user.selectOptions(
      selectIn(row, "metric-select"),
      "CONGRESS_ACTIVITY:PURCHASES",
    );
    expect(representations().summary).toBe("30D");

    await configure(user, async (dialog) => {
      expect(within(dialog).getByRole("heading").textContent).toBe(
        "Configure Congress purchases",
      );
      await user.selectOptions(
        within(dialog).getByLabelText("Lookback"),
        "180",
      );
      await user.selectOptions(
        within(dialog).getByLabelText("Chamber"),
        "HOUSE",
      );
    });

    const expectEverywhere = () => {
      const view = representations();
      expect(view.category.value).toBe("CONGRESSIONAL_TRADING");
      expect(shown(view.category)).toBe("Congressional trading");
      expect(view.metric.value).toBe("CONGRESS_ACTIVITY:PURCHASES");
      expect(shown(view.metric)).toBe("Congress purchases");
      expect(view.summary).toBe("180D · House");
      expect(view.logic).toContain(
        "Congress purchases is above 2 (180D · House)",
      );
      expect(view.helpTitle).toBe("Congress purchases");
      expect(view.helpConfiguration).toBe("180D · House");
    };
    expectEverywhere();

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(saved?.buyLevels[0]?.signal.conditions[0]?.metric).toEqual({
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 180,
      scope: { kind: "ANY" },
      chamber: "HOUSE",
    });

    unmount();
    render(
      <StrategyBuilder
        strategy={{
          ...congressStrategy(),
          definition: saved as StrategyDefinition,
        }}
      />,
    );
    await screen.findByTestId("predicate-row");
    await user.click(screen.getByTestId("metric-select"));
    expectEverywhere();
  });

  it("C: a configured Insider metric leaks nothing into the category chosen after it", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");

    await configure(user, async (dialog) => {
      await user.selectOptions(
        within(dialog).getByLabelText("Lookback"),
        "180",
      );
      await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    });
    expect(representations().summary).toBe("180D · CEO");

    await user.selectOptions(
      selectIn(row, "metric-category-select"),
      "CONGRESSIONAL_TRADING",
    );
    let view = representations();
    expect(shown(view.metric)).toBe("Congress purchases");
    expect(view.summary).toBe("30D");
    expect(view.helpConfiguration).toBe("30D");

    // Back to Insider activity is a fresh start: nothing of 180D · CEO is remembered.
    await user.selectOptions(
      selectIn(row, "metric-category-select"),
      "INSIDER_ACTIVITY",
    );
    view = representations();
    expect(shown(view.metric)).toBe("Insider buyers");
    expect(view.summary).toBe("20D");

    // And a category with no configuration at all carries none.
    await user.selectOptions(
      selectIn(row, "metric-category-select"),
      "OSCILLATORS",
    );
    expect(shown(selectIn(row, "metric-select"))).toBe("RSI 7D");
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
    expect(
      within(row).queryByTestId("operand-configuration-summary"),
    ).toBeNull();
    const builder = screen.getByTestId("strategy-builder").textContent ?? "";
    expect(builder).not.toContain("180D");
    expect(builder).not.toContain("CEO");

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    expect(
      replaceDefinitionMock.mock.calls[0]?.[1].buyLevels[0]?.signal
        .conditions[0],
    ).toEqual({
      id: "c1",
      // The category's own starting rule — not the insider count threshold carried over as an RSI
      // level, which would mean nothing.
      metric: { kind: "OSCILLATOR", seriesId: "RSI_7D" },
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    });
  });
});

describe("the configuration surface", () => {
  it("leaves the explanation where it is when Configure takes focus", async () => {
    // On a phone the explanation is drawn under the focused row, so a focus change moves the page.
    // Configure is a button: a move between press and release would swallow its click.
    const user = userEvent.setup();
    const strategy = insiderStrategy();
    render(
      <StrategyBuilder
        strategy={{
          ...strategy,
          definition: {
            ...strategy.definition,
            buyLevels: [
              {
                id: "buy-1",
                percentage: 100,
                signal: {
                  conditions: [
                    ...strategy.definition.buyLevels[0]!.signal.conditions,
                    {
                      id: "c2",
                      metric: {
                        kind: "CONGRESS_ACTIVITY",
                        measure: "PURCHASES",
                        lookback: 30,
                        scope: { kind: "ANY" },
                        chamber: "ANY",
                      },
                      operator: "IS_ABOVE",
                      value: { kind: "NUMBER", value: 0 },
                    },
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    const [first, second] = await screen.findAllByTestId("predicate-row");
    await user.click(within(first!).getByTestId("metric-select"));
    expect(within(first!).getByTestId("inline-help")).toBeDefined();

    act(() => {
      within(second!).getByTestId("operand-config-button").focus();
    });
    expect(document.activeElement).toBe(
      within(second!).getByTestId("operand-config-button"),
    );
    expect(within(first!).queryByTestId("inline-help")).not.toBeNull();
    expect(within(second!).queryByTestId("inline-help")).toBeNull();
  });

  it("abandoning the dialog changes nothing", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "250");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(representations().summary).toBe("60D · House leadership"),
    );
    expect(
      (screen.getByTestId("save-strategy") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("switches a scope from a group to a specific member through the combobox", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");

    await user.click(within(dialog).getByRole("radio", { name: "A specific one" }));
    // The Apply button waits for a choice: a scope naming nothing would be rejected by the validator.
    expect(
      (
        within(dialog).getByTestId(
          "alternative-data-config-apply",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.type(
      within(dialog).getByLabelText("Search members of Congress"),
      "Pelo",
    );
    await user.click(await within(dialog).findByText("Nancy Pelosi"));
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(saved?.buyLevels[0]?.signal.conditions[0]?.metric).toMatchObject({
      lookback: 60,
      scope: { kind: "ACTOR", actorId: "actor-1" },
    });
  });

  it("offers an insider role filter and no scope, because V1 has no insider groups", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    await screen.findByTestId("predicate-row");
    await configure(user, async (dialog) => {
      expect(
        within(dialog).queryByRole("radiogroup", { name: "Scope" }),
      ).toBeNull();
      await user.click(
        within(dialog).getByRole("checkbox", { name: "Director" }),
      );
      await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    });
    expect(representations().summary).toBe("20D · CEO, Director");
  });

  it("clearing the last filter means every role, not no role", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    await screen.findByTestId("predicate-row");
    await configure(user, async (dialog) => {
      await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    });
    expect(representations().summary).toBe("20D · CEO");

    await configure(user, async (dialog) => {
      await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    });

    // Back to the lookback alone, which is what "every role" looks like: an absent filter, never an
    // empty list. Clearing it also returns the definition to exactly what was saved, so there is
    // nothing left to save — which is itself the proof that an empty toggle produced no `roles: []`.
    expect(representations().summary).toBe("20D");
    expect(
      (screen.getByTestId("save-strategy") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("summarizes a congressional lookback, chamber and owner together", async () => {
    const user = userEvent.setup();
    fetchActorGroupsMock.mockResolvedValue([]);
    render(
      <StrategyBuilder
        strategy={strategyWith("Senate spouses", {
          id: "c1",
          metric: {
            kind: "CONGRESS_ACTIVITY",
            measure: "PURCHASES",
            lookback: 30,
            scope: { kind: "ANY" },
            chamber: "ANY",
          },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 1 },
        })}
      />,
    );
    await screen.findByTestId("predicate-row");
    await configure(user, async (dialog) => {
      await user.selectOptions(
        within(dialog).getByLabelText("Chamber"),
        "SENATE",
      );
      await user.click(
        within(dialog).getByRole("checkbox", { name: "Spouse" }),
      );
      await user.click(within(dialog).getByRole("checkbox", { name: "Self" }));
    });
    expect(representations().summary).toBe("30D · Senate · Self, Spouse");
  });
});

describe("the category and metric selectors", () => {
  it("offers the categories a BUY condition can use, in canonical order", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(optionLabels(selectIn(row, "metric-category-select"))).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Volume",
      "Valuation",
      "Insider activity",
      "Congressional trading",
    ]);
  });

  it("offers only the chosen category's metrics, one per measure", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(optionLabels(selectIn(row, "metric-select"))).toEqual([
      "Insider buyers",
      "Insider sellers",
      "Insider purchase value",
      "Insider sale value",
    ]);
    await user.selectOptions(
      selectIn(row, "metric-category-select"),
      "CONGRESSIONAL_TRADING",
    );
    expect(optionLabels(selectIn(row, "metric-select"))).toEqual([
      "Congress purchases",
      "Congress sales",
      "Congress buyers",
      "Congress sellers",
      "Congress minimum disclosed purchase value",
    ]);
  });

  it("keeps the metric selected after a lookback change", async () => {
    // The select is keyed by the metric's identity, not by its configuration: a reconfigured metric
    // must not read as "Unavailable metric".
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    await screen.findByTestId("predicate-row");
    await configure(user, async (dialog) => {
      await user.selectOptions(
        within(dialog).getByLabelText("Lookback"),
        "120",
      );
    });
    const select = screen.getByTestId("metric-select") as HTMLSelectElement;
    expect(select.value).toBe("INSIDER_ACTIVITY:BUYERS");
    expect(shown(select)).toBe("Insider buyers");
    expect(representations().summary).toBe("120D");
  });

  it("switches from a market metric to an alternative-data one and reconciles the value", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={priceStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.selectOptions(
      selectIn(row, "metric-category-select"),
      "INSIDER_ACTIVITY",
    );
    expect(shown(selectIn(row, "metric-select"))).toBe("Insider buyers");
    // A new category installs the metric's own starting rule — `is above 0`, any such activity at
    // all. Keeping `is below` with the count's floor would have built `is below 0`, which no session
    // can ever satisfy.
    await waitFor(() =>
      expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(
        "0",
      ),
    );
    expect(
      (screen.getByLabelText("Condition") as HTMLSelectElement).value,
    ).toBe("IS_ABOVE");
    expect(representations().logic).toContain(
      "Insider buyers is above 0 (20D)",
    );
  });
});
