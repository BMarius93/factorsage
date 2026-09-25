import {
  STRATEGY_SCHEMA_VERSION,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
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
 * What it proves is the product rule `docs/alternative-data-signals.md` insists on: the condition row
 * stays three controls, everything a metric can be narrowed by is edited in its own surface, and the
 * result reads back as a subtle summary and a Strategy Logic line. It also covers the phone layout,
 * because responsive behaviour is part of acceptance rather than a later cleanup.
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

/** A saved strategy whose only condition is a congressional one scoped to a group. */
function congressStrategy(): StrategyDetailResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id: "s1",
    name: "Follow the Hill",
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
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "BUYERS",
                  lookback: 60,
                  scope: { kind: "GROUP", groupId: "group-1" },
                  chamber: "ANY",
                },
                operator: "IS_AT_LEAST",
                value: { kind: "NUMBER", value: 3 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    },
  };
}

/** An insider strategy, which has no actor scope at all in V1. */
function insiderStrategy(): StrategyDetailResponse {
  const base = congressStrategy();
  return {
    ...base,
    name: "Insiders buying",
    definition: {
      ...base.definition,
      buyLevels: [
        {
          id: "buy-1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: {
                  kind: "INSIDER_ACTIVITY",
                  measure: "BUYERS",
                  lookback: 20,
                },
                operator: "IS_AT_LEAST",
                value: { kind: "NUMBER", value: 2 },
              },
            ],
          },
        },
      ],
    },
  };
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
  it("keeps the row at three controls and puts configuration on its own line", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");

    // Exactly the product's grammar: metric, condition, value — and no fourth control.
    expect(within(row).getAllByTestId("metric-select")).toHaveLength(1);
    expect(within(row).getAllByTestId("operator-select")).toHaveLength(1);
    expect(within(row).getAllByTestId("value-control")).toHaveLength(1);
    expect(within(row).getByTestId("operand-config-button")).toBeDefined();
  });

  it("reads the metric, operator and value as the product's own example", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(
      within(row).getByLabelText("Metric").getAttribute("title"),
    ).toBe("Congress buyers 60D");
    expect(
      (within(row).getByLabelText("Condition") as HTMLSelectElement).value,
    ).toBe("IS_AT_LEAST");
    expect((within(row).getByLabelText("Value") as HTMLInputElement).value).toBe(
      "3",
    );
  });

  it("names the group in the row's summary and in the Strategy Logic line", async () => {
    render(<StrategyBuilder strategy={congressStrategy()} />);
    await waitFor(() =>
      expect(screen.getByTestId("operand-scope-summary").textContent).toBe(
        "House leadership",
      ),
    );
    const preview = screen.getByTestId("logic-preview");
    expect(preview.textContent).toContain(
      "Congress buyers 60D is at least 3",
    );
    expect(preview.textContent).toContain("— House leadership");
  });

  it("falls back to a neutral label when the group's name cannot be resolved", async () => {
    // A deleted group, or a failed request: the identifier is the identity and nothing invents a name.
    fetchActorGroupsMock.mockRejectedValue(new Error("offline"));
    render(<StrategyBuilder strategy={congressStrategy()} />);
    await waitFor(() =>
      expect(screen.getByTestId("operand-scope-summary").textContent).toBe(
        "Selected group",
      ),
    );
  });

  it("shows no summary line for a metric with nothing narrowed", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    expect(within(row).getByTestId("operand-config-button")).toBeDefined();
    expect(within(row).queryByTestId("operand-scope-summary")).toBeNull();
  });

  it("offers no configuration at all on a row with no alternative-data metric", async () => {
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
                    {
                      id: "c1",
                      metric: { kind: "PRICE" },
                      operator: "IS_BELOW",
                      value: { kind: "SERIES", seriesId: "SMA_200D" },
                    },
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    const row = await screen.findByTestId("predicate-row");
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
  });
});

describe("the configuration surface", () => {
  it("edits the lookback and carries it into the label, the preview and the save", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");

    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "90");
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    await waitFor(() =>
      expect(
        screen.getByLabelText("Metric").getAttribute("title"),
      ).toBe("Congress buyers 90D"),
    );
    expect(screen.getByTestId("logic-preview").textContent).toContain(
      "Congress buyers 90D is at least 3",
    );

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalled());
    const saved = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(saved?.buyLevels[0]?.signal.conditions[0]?.metric).toEqual({
      kind: "CONGRESS_ACTIVITY",
      measure: "BUYERS",
      lookback: 90,
      scope: { kind: "GROUP", groupId: "group-1" },
      chamber: "ANY",
    });
  });

  it("abandoning the dialog changes nothing", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={congressStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "250");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Metric").getAttribute("title")).toBe(
      "Congress buyers 60D",
    );
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
      scope: { kind: "ACTOR", actorId: "actor-1" },
    });
  });

  it("offers an insider role filter and no scope, because V1 has no insider groups", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");

    expect(within(dialog).queryByRole("radiogroup", { name: "Scope" })).toBeNull();
    await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Director" }));
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    await waitFor(() =>
      expect(screen.getByTestId("operand-scope-summary").textContent).toBe(
        "CEO, Director",
      ),
    );
  });

  it("clearing the last filter means every role, not no role", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    let dialog = await screen.findByTestId("alternative-data-config");
    await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("operand-scope-summary").textContent).toBe("CEO"),
    );

    await user.click(screen.getByTestId("operand-config-button"));
    dialog = await screen.findByTestId("alternative-data-config");
    await user.click(within(dialog).getByRole("checkbox", { name: "CEO" }));
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    // The summary is gone, which is what "every role" looks like: an absent filter, never an empty
    // list. Clearing it also returns the definition to exactly what was saved, so there is nothing
    // left to save — which is itself the proof that an empty toggle produced no `roles: []`.
    await waitFor(() =>
      expect(screen.queryByTestId("operand-scope-summary")).toBeNull(),
    );
    expect(
      (screen.getByTestId("save-strategy") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("summarizes a congressional scope, chamber and owner together", async () => {
    const user = userEvent.setup();
    fetchActorGroupsMock.mockResolvedValue([]);
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
                    {
                      id: "c1",
                      metric: {
                        kind: "CONGRESS_ACTIVITY",
                        measure: "PURCHASES",
                        lookback: 30,
                        scope: { kind: "ANY" },
                        chamber: "ANY",
                      },
                      operator: "IS_AT_LEAST",
                      value: { kind: "NUMBER", value: 2 },
                    },
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");
    await user.selectOptions(within(dialog).getByLabelText("Chamber"), "SENATE");
    await user.click(within(dialog).getByRole("checkbox", { name: "Self" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Spouse" }));
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    await waitFor(() =>
      expect(screen.getByTestId("operand-scope-summary").textContent).toBe(
        "Senate · Self, Spouse",
      ),
    );
  });
});

describe("the metric selector", () => {
  it("offers the two new groups beside the existing ones", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const select = await screen.findByLabelText("Metric");
    const groups = [...select.querySelectorAll("optgroup")].map((group) =>
      group.getAttribute("label"),
    );
    expect(groups).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Volume",
      "Valuation",
      "Insider activity",
      "Congressional trading",
    ]);
  });

  it("offers a measure as one option, with its default lookback in the label", async () => {
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const select = await screen.findByLabelText("Metric");
    const labels = [...select.querySelectorAll("option")].map(
      (option) => option.textContent,
    );
    expect(labels).toContain("Insider buyers 20D");
    expect(labels).toContain("Congress purchases 30D");
  });

  it("keeps the metric selected after a lookback change", async () => {
    // The select is keyed by measure, not by configuration: a reconfigured metric must not read as
    // "Unavailable metric".
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={insiderStrategy()} />);
    const row = await screen.findByTestId("predicate-row");
    await user.click(within(row).getByTestId("operand-config-button"));
    const dialog = await screen.findByTestId("alternative-data-config");
    await user.selectOptions(within(dialog).getByLabelText("Lookback"), "120");
    await user.click(within(dialog).getByTestId("alternative-data-config-apply"));

    const select = (await screen.findByLabelText("Metric")) as HTMLSelectElement;
    await waitFor(() =>
      expect(select.value).toBe("INSIDER_ACTIVITY:BUYERS"),
    );
    expect(select.getAttribute("title")).toBe("Insider buyers 120D");
  });

  it("switches from a market metric to an alternative-data one and reconciles the value", async () => {
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
                    {
                      id: "c1",
                      metric: { kind: "PRICE" },
                      operator: "IS_BELOW",
                      value: { kind: "SERIES", seriesId: "SMA_200D" },
                    },
                  ],
                },
              },
            ],
          },
        }}
      />,
    );
    await user.selectOptions(
      await screen.findByLabelText("Metric"),
      "INSIDER_ACTIVITY:BUYERS",
    );
    // A series Value cannot survive a count metric, so the canonical reconciliation replaces it with
    // the count default rather than leaving something the validator would reject.
    await waitFor(() =>
      expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe(
        "1",
      ),
    );
    // `is below` is kept, because the new metric genuinely supports it: reconciliation replaces only
    // what the metric can no longer express, and resetting a still-valid operator would move a rule
    // the user did not touch.
    expect(
      (screen.getByLabelText("Condition") as HTMLSelectElement).value,
    ).toBe("IS_BELOW");
  });
});
