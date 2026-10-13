import {
  STRATEGY_SCHEMA_VERSION,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchActorCatalogStatus,
  fetchActorGroup,
  fetchActorGroups,
  resolveActors,
  searchActors,
} from "../../alternative-data/api/alternative-data-api";
import { replaceStrategyDefinition } from "../api/strategies-api";
import { StrategyBuilder } from "./StrategyBuilder";
import {
  activeCategory,
  activeFamily,
  categoryLabels,
  familyLabels,
  showFamily,
  chooseMetric,
  openPicker,
  optionLabels as pickerOptionLabels,
  pickerText,
  pickerTrigger,
  pickerValue,
  showCategory,
} from "./__testing__/operand-picker";

/**
 * The alternative-data half of the Strategy Builder.
 *
 * What it proves is the rule the Metric picker exists for: a metric's **identity** — its category
 * and its measure — is what the picker shows, and its **configuration** — the lookback, the scope,
 * the filters — is edited in its own dialog and rendered by one canonical summary. The row, the Strategy Logic sidebar, the explanation panel, the saved document and a
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
  fetchActorCatalogStatus: vi.fn(),
  fetchActorGroups: vi.fn(),
  fetchActorGroup: vi.fn(),
}));

const replaceDefinitionMock = vi.mocked(replaceStrategyDefinition);
const searchActorsMock = vi.mocked(searchActors);
const resolveActorsMock = vi.mocked(resolveActors);
const fetchActorCatalogStatusMock = vi.mocked(fetchActorCatalogStatus);
const fetchActorGroupsMock = vi.mocked(fetchActorGroups);
const fetchActorGroupMock = vi.mocked(fetchActorGroup);

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

const TUBERVILLE: AlternativeDataActorResponse = {
  id: "actor-2",
  externalId: "T000278",
  displayName: "Tommy Tuberville",
  chamber: "SENATE",
  state: "AL",
};

const KHANNA: AlternativeDataActorResponse = {
  id: "actor-3",
  externalId: "K000389",
  displayName: "Ro Khanna",
  chamber: "HOUSE",
  state: "CA",
  district: "CA17",
};

/** The members the mocked catalog holds. */
const CATALOG = [PELOSI, TUBERVILLE, KHANNA] as const;

/** The legacy group as its detail route answers: the summary plus its members. */
const LEADERSHIP_DETAIL: ActorGroupDetailResponse = {
  ...LEADERSHIP,
  memberCount: 2,
  members: [TUBERVILLE, PELOSI],
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

/** A congressional condition scoped to members the rule selects itself. */
function selectionCondition(
  id: string,
  actorIds: readonly string[],
): StrategyDefinition["buyLevels"][number]["signal"]["conditions"][number] {
  return {
    id,
    metric: {
      kind: "CONGRESS_ACTIVITY",
      measure: "BUYERS",
      lookback: 60,
      scope: { kind: "ACTORS", actorIds: [...actorIds] },
      chamber: "ANY",
    },
    operator: "IS_ABOVE",
    value: { kind: "NUMBER", value: 2 },
  };
}

/** A saved strategy whose only condition selects members directly. */
function selectionStrategy(
  actorIds: readonly string[] = [PELOSI.id, TUBERVILLE.id],
): StrategyDetailResponse {
  return strategyWith("Follow the Hill", selectionCondition("c1", actorIds));
}

/**
 * A strategy saved before 2026-10-11, whose only condition still names a Congress group.
 *
 * Nothing writes this shape any more; it is what an older strategy version reads back as.
 */
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

/** A congressional strategy that counts every member: no selection, so no picker on screen. */
function anyoneStrategy(): StrategyDetailResponse {
  return strategyWith("The whole Hill", {
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

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent ?? "");
}

/** Every place the Builder describes the row's metric, read at once. */
function representations() {
  const row = screen.getByTestId("predicate-row");
  const side = screen.getByTestId("explanation-panel");
  return {
    metricKey: pickerValue(row),
    metricLabel: pickerText(row),
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

/** The category the row's Metric picker opens on, read by opening it and closing it again. */
async function pickerCategory(
  user: ReturnType<typeof userEvent.setup>,
  row: HTMLElement,
): Promise<string | null> {
  const category = activeCategory(await openPicker(user, row));
  await user.keyboard("{Escape}");
  return category;
}

/** Focuses the row's Metric control, which is what points the explanation at it. */
function focusMetric(row: HTMLElement) {
  act(() => {
    pickerTrigger(row).focus();
  });
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

/** The saved scope of the nth condition of the first BUY level, as the Builder last submitted it. */
function savedScope(conditionIndex = 0): unknown {
  const saved = replaceDefinitionMock.mock.calls.at(-1)?.[1];
  const metric = saved?.buyLevels[0]?.signal.conditions[conditionIndex]?.metric;
  return metric?.kind === "CONGRESS_ACTIVITY" ? metric.scope : undefined;
}

function chipNames(scope: HTMLElement): string[] {
  return within(scope)
    .queryAllByTestId("actor-chip")
    .map((chip) => chip.firstChild?.textContent ?? "");
}

async function openConfiguration(
  user: ReturnType<typeof userEvent.setup>,
  row?: HTMLElement,
): Promise<HTMLElement> {
  const scope = row ?? (await screen.findByTestId("predicate-row"));
  await user.click(within(scope).getByTestId("operand-config-button"));
  return screen.findByTestId("alternative-data-config");
}

async function pickMember(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  term: string,
  name: string,
): Promise<void> {
  await user.type(
    within(dialog).getByLabelText("Search members of Congress"),
    term,
  );
  await user.click(
    await within(within(dialog).getByRole("listbox")).findByText(name),
  );
}

function applyButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByTestId(
    "alternative-data-config-apply",
  ) as HTMLButtonElement;
}

beforeEach(() => {
  // A catalog of three, searched the way the API searches it: by a case-insensitive part of the name.
  searchActorsMock.mockImplementation(async (input = {}) =>
    CATALOG.filter((actor) =>
      actor.displayName.toLowerCase().includes((input.term ?? "").toLowerCase()),
    ),
  );
  resolveActorsMock.mockImplementation(async (actorIds) =>
    CATALOG.filter((actor) => actorIds.includes(actor.id)),
  );
  // The catalog as a deployment normally has it: filled from the provider's member directory.
  fetchActorCatalogStatusMock.mockResolvedValue({
    state: "SYNCHRONIZED",
    synchronizedAt: "2026-10-11T12:00:00.000Z",
  });
  fetchActorGroupsMock.mockResolvedValue([LEADERSHIP]);
  fetchActorGroupMock.mockResolvedValue(LEADERSHIP_DETAIL);
  replaceDefinitionMock.mockImplementation(async (_id, definition) => ({
    ...congressStrategy(),
    definition,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the alternative-data condition row", () => {
  it("reads Metric, Condition and Value, and puts configuration on its own line", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");

    expect(within(row).queryByTestId("metric-category-select")).toBeNull();
    expect(within(row).getAllByTestId("metric-picker")).toHaveLength(1);
    expect(within(row).getAllByTestId("operator-select")).toHaveLength(1);
    expect(within(row).getAllByTestId("value-control")).toHaveLength(1);
    expect(within(row).getByTestId("operand-config-button")).toBeDefined();

    expect(pickerText(row)).toBe("Congress buyers");
    expect(await pickerCategory(user, row)).toBe("CONGRESSIONAL_TRADING");
    expect(selectIn(row, "operator-select").value).toBe("IS_ABOVE");
    expect(
      (within(row).getByLabelText("Value") as HTMLInputElement).value,
    ).toBe("2");
  });

  it("names the metric by its identity alone, never by a configuration", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(pickerTrigger(row).getAttribute("title")).toBe("Congress buyers");
    const panel = await openPicker(user, row);
    for (const category of ["CONGRESSIONAL_TRADING", "INSIDER_ACTIVITY"]) {
      await showCategory(user, panel, category);
      for (const label of pickerOptionLabels(panel)) {
        expect(label).not.toMatch(/\d+D\b/);
      }
    }
  });

  it("summarizes the lookback and the selected members on the row and on the Strategy Logic line", async () => {
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · Nancy Pelosi, Tommy Tuberville"),
    );
    expect(representations().logic).toContain(
      "Congress buyers is above 2 (60D · Nancy Pelosi, Tommy Tuberville)",
    );
  });

  it("names the first two of a longer selection and counts the rest", async () => {
    render(
      <StrategyBuilder
        strategy={selectionStrategy([PELOSI.id, TUBERVILLE.id, KHANNA.id])}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · Nancy Pelosi, Ro Khanna +1"),
    );
  });

  it("says how many members are selected while their names are unresolved", async () => {
    resolveActorsMock.mockRejectedValue(new Error("offline"));
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · 2 selected members"),
    );
  });

  it("still names the group behind a rule saved before groups left the product", async () => {
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
    expect(pickerTrigger(row).getAttribute("aria-describedby")).toContain(
      summaryId,
    );
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

    await chooseMetric(
      user,
      row,
      "INSIDER_ACTIVITY",
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

    const expectEverywhere180 = async () => {
      expect(
        await pickerCategory(user, screen.getByTestId("predicate-row")),
      ).toBe("INSIDER_ACTIVITY");
      const view = representations();
      expect(view.metricKey).toBe("INSIDER_ACTIVITY:SELLERS");
      expect(view.metricLabel).toBe("Insider sellers");
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
    await expectEverywhere180();

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
    focusMetric(screen.getByTestId("predicate-row"));
    await expectEverywhere180();
  });

  it("B: Congressional trading -> Congress purchases keeps its members, configured to 180D + House agrees everywhere, saved and reloaded", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <StrategyBuilder strategy={selectionStrategy()} />,
    );
    const row = await screen.findByTestId("predicate-row");
    await waitFor(() =>
      expect(representations().summary).toBe(
        "60D · Nancy Pelosi, Tommy Tuberville",
      ),
    );

    // Every congressional measure takes the same configuration, so another measure keeps it: the
    // lookback and the selected members follow the choice rather than silently resetting.
    await chooseMetric(
      user,
      row,
      "CONGRESSIONAL_TRADING",
      "CONGRESS_ACTIVITY:PURCHASES",
    );
    expect(representations().summary).toBe(
      "60D · Nancy Pelosi, Tommy Tuberville",
    );

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

    const expectEverywhere = async () => {
      expect(
        await pickerCategory(user, screen.getByTestId("predicate-row")),
      ).toBe("CONGRESSIONAL_TRADING");
      const view = representations();
      expect(view.metricKey).toBe("CONGRESS_ACTIVITY:PURCHASES");
      expect(view.metricLabel).toBe("Congress purchases");
      expect(view.summary).toBe(
        "180D · Nancy Pelosi, Tommy Tuberville · House",
      );
      expect(view.logic).toContain(
        "Congress purchases is above 2 (180D · Nancy Pelosi, Tommy Tuberville · House)",
      );
      expect(view.helpTitle).toBe("Congress purchases");
      expect(view.helpConfiguration).toBe(
        "180D · Nancy Pelosi, Tommy Tuberville · House",
      );
    };
    await expectEverywhere();

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(saved?.buyLevels[0]?.signal.conditions[0]?.metric).toEqual({
      kind: "CONGRESS_ACTIVITY",
      measure: "PURCHASES",
      lookback: 180,
      scope: { kind: "ACTORS", actorIds: [PELOSI.id, TUBERVILLE.id] },
      chamber: "HOUSE",
    });

    unmount();
    render(
      <StrategyBuilder
        strategy={{
          ...selectionStrategy(),
          definition: saved as StrategyDefinition,
        }}
      />,
    );
    await screen.findByTestId("predicate-row");
    focusMetric(screen.getByTestId("predicate-row"));
    await waitFor(() =>
      expect(representations().summary).toBe(
        "180D · Nancy Pelosi, Tommy Tuberville · House",
      ),
    );
    await expectEverywhere();
  });

  it("keeps the group of a rule saved before groups left the product when only its measure changes", async () => {
    // Choosing another congressional measure is not a configuration: the scope the rule was saved
    // with follows it untouched. It is the Configure dialog that turns a group into its members.
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await waitFor(() =>
      expect(representations().summary).toBe("60D · House leadership"),
    );

    await chooseMetric(
      user,
      row,
      "CONGRESSIONAL_TRADING",
      "CONGRESS_ACTIVITY:PURCHASES",
    );
    const view = representations();
    expect(view.metricLabel).toBe("Congress purchases");
    expect(view.summary).toBe("60D · House leadership");
    expect(view.logic).toContain(
      "Congress purchases is above 2 (60D · House leadership)",
    );
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

    await chooseMetric(
      user,
      row,
      "CONGRESSIONAL_TRADING",
      "CONGRESS_ACTIVITY:PURCHASES",
    );
    let view = representations();
    expect(view.metricLabel).toBe("Congress purchases");
    expect(view.summary).toBe("30D");
    expect(view.helpConfiguration).toBe("30D");

    // Back to Insider activity is a fresh start: nothing of 180D · CEO is remembered.
    await chooseMetric(
      user,
      row,
      "INSIDER_ACTIVITY",
      "INSIDER_ACTIVITY:BUYERS",
    );
    view = representations();
    expect(view.metricLabel).toBe("Insider buyers");
    expect(view.summary).toBe("20D");

    // And a category with no configuration at all carries none.
    await chooseMetric(user, row, "OSCILLATORS", "OSCILLATOR:RSI_7D");
    expect(pickerText(row)).toBe("RSI 7D");
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
    focusMetric(first!);
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
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    const dialog = await openConfiguration(user);
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "250");
    await pickMember(user, dialog, "Khan", "Ro Khanna");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(representations().summary).toBe(
        "60D · Nancy Pelosi, Tommy Tuberville",
      ),
    );
    expect(
      (screen.getByTestId("save-strategy") as HTMLButtonElement).disabled,
    ).toBe(true);
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

describe("the Metric picker", () => {
  it("offers the families a BUY condition can use, with their categories as subgroups, in canonical order", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    const panel = await openPicker(user, row);
    // Position is absent: a BUY level has no position to measure.
    expect(familyLabels(panel)).toEqual([
      "Technical",
      "Fundamentals",
      "Valuation",
      "Activity",
    ]);
    // The rule's own family is the one on show, with its two categories as subgroups.
    expect(activeFamily(panel)).toBe("ACTIVITY");
    expect(categoryLabels(panel)).toEqual([
      "Insider activity",
      "Congressional trading",
    ]);
    await showFamily(user, panel, "TECHNICAL");
    expect(categoryLabels(panel)).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Volume",
    ]);
    // A family of one category lists its metrics directly, with no subgroup to open.
    await showFamily(user, panel, "FUNDAMENTALS");
    expect(categoryLabels(panel)).toEqual([]);
    await showFamily(user, panel, "VALUATION");
    expect(categoryLabels(panel)).toEqual([]);
  });

  it("offers only the chosen category's metrics, one per measure", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    const panel = await openPicker(user, row);
    expect(pickerOptionLabels(panel)).toEqual([
      "Insider buyers",
      "Insider sellers",
      "Insider purchase value",
      "Insider sale value",
    ]);
    await showCategory(user, panel, "CONGRESSIONAL_TRADING");
    expect(pickerOptionLabels(panel)).toEqual([
      "Congress purchases",
      "Congress sales",
      "Congress buyers",
      "Congress sellers",
      "Congress minimum disclosed purchase value",
    ]);
  });

  it("keeps the metric selected after a lookback change", async () => {
    // The picker is keyed by the metric's identity, not by its configuration: a reconfigured metric
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
    const row = screen.getByTestId("predicate-row");
    expect(pickerValue(row)).toBe("INSIDER_ACTIVITY:BUYERS");
    expect(pickerText(row)).toBe("Insider buyers");
    expect(representations().summary).toBe("120D");
  });

  it("keeps an Insider configuration when another Insider measure is chosen, and starts its threshold", async () => {
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
    await chooseMetric(
      user,
      row,
      "INSIDER_ACTIVITY",
      "INSIDER_ACTIVITY:SALE_VALUE",
    );
    expect(pickerText(row)).toBe("Insider sale value");
    expect(representations().summary).toBe("180D · CEO");
    // A count of 1 is not an amount of money: the new unit starts from its own floor.
    expect(representations().logic).toContain(
      "Insider sale value is above $0 (180D · CEO)",
    );
  });

  it("switches from a market metric to an alternative-data one and reconciles the value", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={priceStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await chooseMetric(
      user,
      row,
      "INSIDER_ACTIVITY",
      "INSIDER_ACTIVITY:BUYERS",
    );
    expect(pickerText(row)).toBe("Insider buyers");
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

describe("selecting members of Congress", () => {
  it("offers anyone or selected members, and never a group", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    const dialog = await openConfiguration(user);
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => radio.parentElement?.textContent),
    ).toEqual(["Anyone", "Selected members"]);
    expect(within(dialog).queryByTestId("alt-group-picker")).toBeNull();
    expect(fetchActorGroupMock).not.toHaveBeenCalled();
  });

  it("adds members as chips and saves their ids, sorted, in the condition", async () => {
    const user = userEvent.setup();
    const strategy = strategyWith("Follow the Hill", {
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
    });
    render(<StrategyBuilder strategy={strategy} />);
    const dialog = await openConfiguration(user);

    await user.click(
      within(dialog).getByRole("radio", { name: "Selected members" }),
    );
    // Nobody chosen yet: a selection of nobody is not a rule, so it cannot be applied.
    expect(applyButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByTestId("alt-actor-count").textContent).toContain(
      "Select at least one member.",
    );

    await pickMember(user, dialog, "Tub", "Tommy Tuberville");
    await pickMember(user, dialog, "Pelo", "Nancy Pelosi");
    // Newest first, and each exactly once.
    expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]);
    expect(within(dialog).getByTestId("alt-actor-count").textContent).toContain(
      "2 of 250 selected.",
    );
    expect(applyButton(dialog).disabled).toBe(false);
    await user.click(applyButton(dialog));

    await waitFor(() =>
      expect(representations().summary).toBe(
        "30D · Nancy Pelosi, Tommy Tuberville",
      ),
    );
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    // The ids, never the names, and in canonical order whatever order they were picked in.
    expect(savedScope()).toEqual({
      kind: "ACTORS",
      actorIds: ["actor-1", "actor-2"],
    });
  });

  it("keeps the chosen members in view while the search changes", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    const dialog = await openConfiguration(user);
    await waitFor(() =>
      expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]),
    );

    const search = within(dialog).getByLabelText("Search members of Congress");
    await user.type(search, "Khan");
    const listbox = within(dialog).getByRole("listbox");
    await within(listbox).findByText("Ro Khanna");
    // The list now holds only the match; the chips are untouched by what is being searched for.
    expect(within(listbox).queryByText("Nancy Pelosi")).toBeNull();
    expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]);

    await user.clear(search);
    await user.type(search, "zzz");
    await within(listbox).findByText(/No matches\./);
    expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]);
  });

  /** Opens the picker, searches for somebody the catalog does not hold, and reads what it says. */
  async function searchForNobody(): Promise<{ empty: string; note: string }> {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    const dialog = await openConfiguration(user);
    await user.type(
      within(dialog).getByLabelText("Search members of Congress"),
      "Nobody Here",
    );
    const empty = await within(dialog).findByText(/No matches\./);
    return {
      empty: empty.textContent ?? "",
      note: within(dialog).getByTestId("alt-actor-count").textContent ?? "",
    };
  }

  it("says nobody matches, and warns of nothing, once the member directory is loaded", async () => {
    const { empty, note } = await searchForNobody();
    await waitFor(() =>
      expect(
        screen.getByTestId("alt-actor-catalog").getAttribute("data-state"),
      ).toBe("SYNCHRONIZED"),
    );
    const after = screen.getByTestId("alt-actor-count").textContent ?? "";

    expect(empty).toContain(
      "No current or former member of Congress matches. Try the surname alone.",
    );
    expect(after).toContain(
      "The list covers current and former members of Congress, whether or not they have traded.",
    );
    // The warning about a list grown from loaded disclosures is gone, because it is no longer true.
    for (const text of [empty, note, after]) {
      expect(text).not.toContain("not every member of Congress");
      expect(text).not.toContain("already loaded");
    }
  });

  it("says the directory has not been loaded yet, so an empty search is not read as nobody", async () => {
    fetchActorCatalogStatusMock.mockResolvedValue({ state: "NOT_SYNCHRONIZED" });
    const { empty } = await searchForNobody();

    expect(empty).toContain(
      "The member directory has not been loaded yet, so only members with disclosures FactorSage has already loaded can be found.",
    );
    expect(screen.getByTestId("alt-actor-count").textContent).toContain(
      "The member directory has not been loaded yet: the list holds only the members who appear in the disclosures FactorSage has loaded so far, so it is not every member of Congress.",
    );
  });

  it("says the directory could not be loaded, which is a different statement from not yet", async () => {
    fetchActorCatalogStatusMock.mockResolvedValue({
      state: "SYNCHRONIZATION_FAILED",
    });
    const { empty } = await searchForNobody();

    expect(empty).toContain(
      "The member directory could not be loaded, so only members with disclosures FactorSage has already loaded can be found.",
    );
    const note = screen.getByTestId("alt-actor-count").textContent ?? "";
    expect(note).toContain("The member directory could not be loaded:");
    expect(note).toContain("it is not every member of Congress");
    expect(note).not.toContain("has not been loaded yet");
  });

  it("claims nothing about the list while it does not know, and still lets a member be chosen", async () => {
    fetchActorCatalogStatusMock.mockRejectedValue(new Error("offline"));
    const { empty, note } = await searchForNobody();

    expect(empty).toBe("No matches.Try the surname alone.");
    expect(note).not.toContain("current and former members");
    expect(note).not.toContain("not every member of Congress");
    expect(
      screen.getByTestId("alt-actor-catalog").getAttribute("data-state"),
    ).toBe("UNKNOWN");
    // Not knowing blocks nothing: the saved selection is intact and Apply is available.
    expect(chipNames(screen.getByTestId("alternative-data-config"))).toEqual([
      "Nancy Pelosi",
      "Tommy Tuberville",
    ]);
    expect(
      (screen.getByTestId("alternative-data-config-apply") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("asks about the catalog once, and only when the picker is on screen", async () => {
    const user = userEvent.setup();
    // "Anyone": no picker, so nothing to word.
    const { unmount } = render(<StrategyBuilder strategy={anyoneStrategy()} />);
    const anyone = await openConfiguration(user);
    expect(fetchActorCatalogStatusMock).not.toHaveBeenCalled();

    // Choosing "Selected members" shows the picker, and asks.
    await user.click(
      within(anyone).getByRole("radio", { name: "Selected members" }),
    );
    await waitFor(() =>
      expect(fetchActorCatalogStatusMock).toHaveBeenCalledTimes(1),
    );
    // Searching does not ask again: the answer is about the catalog, not about a term.
    await user.type(
      within(anyone).getByLabelText("Search members of Congress"),
      "Pelosi",
    );
    await within(anyone).findByRole("option", { name: /Nancy Pelosi/ });
    expect(fetchActorCatalogStatusMock).toHaveBeenCalledTimes(1);
    unmount();

    // An insider metric has no members to select and never asks.
    fetchActorCatalogStatusMock.mockClear();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    await openConfiguration(user);
    expect(fetchActorCatalogStatusMock).not.toHaveBeenCalled();
  });

  it("loads every saved member when an existing condition is reopened", async () => {
    const user = userEvent.setup();
    render(
      <StrategyBuilder
        strategy={selectionStrategy([KHANNA.id, PELOSI.id, TUBERVILLE.id])}
      />,
    );
    const dialog = await openConfiguration(user);
    expect(
      (
        within(dialog).getByRole("radio", {
          name: "Selected members",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    // Alphabetical once resolved: the saved order is by id and means nothing to a reader.
    await waitFor(() =>
      expect(chipNames(dialog)).toEqual([
        "Nancy Pelosi",
        "Ro Khanna",
        "Tommy Tuberville",
      ]),
    );
    // Asked for by id, in the selection's canonical order, never by name.
    expect(resolveActorsMock).toHaveBeenCalledWith(
      [PELOSI.id, TUBERVILLE.id, KHANNA.id],
      expect.anything(),
    );
  });

  it("removes a member by its chip, and by picking it again, without recreating the condition", async () => {
    const user = userEvent.setup();
    render(
      <StrategyBuilder
        strategy={selectionStrategy([KHANNA.id, PELOSI.id, TUBERVILLE.id])}
      />,
    );
    const dialog = await openConfiguration(user);
    await waitFor(() => expect(chipNames(dialog)).toHaveLength(3));

    await user.click(
      within(dialog).getByRole("button", { name: "Remove Ro Khanna" }),
    );
    expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]);

    // Picking a member who is already chosen removes them: nobody can be selected twice.
    await pickMember(user, dialog, "Pelo", "Nancy Pelosi");
    expect(chipNames(dialog)).toEqual(["Tommy Tuberville"]);

    await user.click(applyButton(dialog));
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls.at(-1)?.[1];
    // The same condition, edited in place: its id, operator, value and lookback are as they were.
    expect(saved?.buyLevels[0]?.signal.conditions[0]).toMatchObject({
      id: "c1",
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 2 },
      metric: {
        measure: "BUYERS",
        lookback: 60,
        scope: { kind: "ACTORS", actorIds: ["actor-2"] },
      },
    });
  });

  it("will not apply an empty selection, and keeps the members if the user goes to Anyone and back", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={selectionStrategy([PELOSI.id])} />);
    const dialog = await openConfiguration(user);
    await waitFor(() => expect(chipNames(dialog)).toEqual(["Nancy Pelosi"]));

    await user.click(
      within(dialog).getByRole("button", { name: "Remove Nancy Pelosi" }),
    );
    expect(applyButton(dialog).disabled).toBe(true);

    await pickMember(user, dialog, "Tub", "Tommy Tuberville");
    expect(applyButton(dialog).disabled).toBe(false);

    await user.click(within(dialog).getByRole("radio", { name: "Anyone" }));
    expect(within(dialog).queryByTestId("alt-actor-picker")).toBeNull();
    expect(applyButton(dialog).disabled).toBe(false);
    await user.click(
      within(dialog).getByRole("radio", { name: "Selected members" }),
    );
    expect(chipNames(dialog)).toEqual(["Tommy Tuberville"]);

    await user.click(within(dialog).getByRole("radio", { name: "Anyone" }));
    await user.click(applyButton(dialog));
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    expect(savedScope()).toEqual({ kind: "ANY" });
  });

  it("shows a saved member the catalog no longer holds, and waits for it to be removed", async () => {
    const user = userEvent.setup();
    render(
      <StrategyBuilder strategy={selectionStrategy([PELOSI.id, "actor-gone"])} />,
    );
    const dialog = await openConfiguration(user);
    await waitFor(() =>
      expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Unavailable member"]),
    );
    expect(
      within(dialog).getByTestId("alt-actor-unavailable").textContent,
    ).toBe("1 selected member is no longer available. Remove it to apply.");
    expect(applyButton(dialog).disabled).toBe(true);

    await user.click(
      within(dialog).getByRole("button", { name: "Remove Unavailable member" }),
    );
    expect(within(dialog).queryByTestId("alt-actor-unavailable")).toBeNull();
    expect(applyButton(dialog).disabled).toBe(false);
  });

  it("keeps the saved selection applicable when the names cannot be loaded", async () => {
    const user = userEvent.setup();
    resolveActorsMock.mockRejectedValue(new Error("offline"));
    render(<StrategyBuilder strategy={selectionStrategy()} />);
    const dialog = await openConfiguration(user);
    await waitFor(() =>
      expect(chipNames(dialog)).toEqual(["Selected member", "Selected member"]),
    );
    // The selection is the ids, and those are intact; only the labels are missing.
    expect(applyButton(dialog).disabled).toBe(false);
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "90");
    await user.click(applyButton(dialog));
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    expect(savedScope()).toEqual({
      kind: "ACTORS",
      actorIds: ["actor-1", "actor-2"],
    });
  });

  it("gives two congressional conditions their own selections", async () => {
    const user = userEvent.setup();
    const strategy = selectionStrategy([PELOSI.id]);
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
                    selectionCondition("c1", [PELOSI.id]),
                    selectionCondition("c2", [TUBERVILLE.id]),
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    const [first, second] = await screen.findAllByTestId("predicate-row");
    await waitFor(() =>
      expect(
        within(second!).getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · Tommy Tuberville"),
    );

    // Editing the second condition's members…
    const dialog = await openConfiguration(user, second);
    await waitFor(() => expect(chipNames(dialog)).toEqual(["Tommy Tuberville"]));
    await pickMember(user, dialog, "Khan", "Ro Khanna");
    await user.click(applyButton(dialog));

    // …changes the second and leaves the first exactly as it was.
    await waitFor(() =>
      expect(
        within(second!).getByTestId("operand-configuration-summary").textContent,
      ).toBe("60D · Ro Khanna, Tommy Tuberville"),
    );
    expect(
      within(first!).getByTestId("operand-configuration-summary").textContent,
    ).toBe("60D · Nancy Pelosi");

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    expect(savedScope(0)).toEqual({ kind: "ACTORS", actorIds: ["actor-1"] });
    expect(savedScope(1)).toEqual({
      kind: "ACTORS",
      actorIds: ["actor-2", "actor-3"],
    });
  });

  it("folds a long selection so the dialog stays one page, and unfolds it on request", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `actor-many-${String(index).padStart(2, "0")}`,
      externalId: `M0000${String(index).padStart(2, "0")}`,
      displayName: `Member ${String(index).padStart(2, "0")}`,
      chamber: "HOUSE" as const,
    }));
    resolveActorsMock.mockResolvedValue(many);
    render(
      <StrategyBuilder strategy={selectionStrategy(many.map((m) => m.id))} />,
    );
    const dialog = await openConfiguration(user);
    await waitFor(() => expect(chipNames(dialog)[0]).toBe("Member 00"));

    expect(chipNames(dialog)).toHaveLength(12);
    expect(within(dialog).getByTestId("actor-chips-expand").textContent).toBe(
      "+28 more",
    );
    expect(within(dialog).getByTestId("alt-actor-count").textContent).toContain(
      "40 of 250 selected.",
    );

    await user.click(within(dialog).getByTestId("actor-chips-expand"));
    expect(chipNames(dialog)).toHaveLength(40);
    await user.click(within(dialog).getByTestId("actor-chips-collapse"));
    expect(chipNames(dialog)).toHaveLength(12);
  });
});

describe("a rule saved with a Congress group", () => {
  it("opens on the group's members, and one Apply turns the rule into a selection", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const dialog = await openConfiguration(user);

    expect(fetchActorGroupMock).toHaveBeenCalledWith(
      "group-1",
      expect.anything(),
    );
    await waitFor(() =>
      expect(chipNames(dialog)).toEqual(["Nancy Pelosi", "Tommy Tuberville"]),
    );
    expect(within(dialog).getByTestId("alt-legacy-group").textContent).toContain(
      "This rule used the group “House leadership”.",
    );
    expect(
      (
        within(dialog).getByRole("radio", {
          name: "Selected members",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    await user.click(applyButton(dialog));
    await waitFor(() =>
      expect(representations().summary).toBe(
        "60D · Nancy Pelosi, Tommy Tuberville",
      ),
    );
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    // What is saved names the members and no group: nothing writes a group reference any more.
    expect(savedScope()).toEqual({
      kind: "ACTORS",
      actorIds: ["actor-1", "actor-2"],
    });
  });

  it("asks for the members when the group can no longer be read, rather than guessing", async () => {
    const user = userEvent.setup();
    fetchActorGroupMock.mockRejectedValue(new Error("not found"));
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const dialog = await openConfiguration(user);

    await waitFor(() =>
      expect(
        within(dialog).getByTestId("alt-legacy-group").textContent,
      ).toContain("This rule used a group that is no longer available."),
    );
    expect(chipNames(dialog)).toEqual([]);
    // Neither "everyone" nor "nobody" is assumed: the rule cannot be applied until someone is chosen.
    expect(applyButton(dialog).disabled).toBe(true);

    await pickMember(user, dialog, "Khan", "Ro Khanna");
    expect(applyButton(dialog).disabled).toBe(false);
  });

  it("does not let the rule be applied before the group's members have loaded", async () => {
    const user = userEvent.setup();
    let release: (group: ActorGroupDetailResponse) => void = () => undefined;
    fetchActorGroupMock.mockReturnValue(
      new Promise<ActorGroupDetailResponse>((resolve) => {
        release = resolve;
      }),
    );
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const dialog = await openConfiguration(user);

    expect(applyButton(dialog).disabled).toBe(true);
    expect(within(dialog).queryByTestId("alt-actor-picker")).toBeNull();
    await act(async () => {
      release(LEADERSHIP_DETAIL);
    });
    await waitFor(() => expect(applyButton(dialog).disabled).toBe(false));
  });
});
