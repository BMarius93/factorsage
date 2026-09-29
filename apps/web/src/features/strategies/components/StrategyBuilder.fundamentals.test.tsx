import {
  FUNDAMENTAL_METRIC_CATALOG,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStrategy } from "../api/strategies-api";
import { StrategyBuilder } from "./StrategyBuilder";

/**
 * Fundamentals in the Strategy Builder.
 *
 * The Builder holds no Fundamentals list, label, unit or rule of its own: the category, the fifteen
 * metrics, the operators, the Value's unit and bounds, the sentence and the explanation all come
 * from `@intrinsic/contracts`. These cases prove the generic row renders what the registry says.
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
  return {
    ...actual,
    createStrategy: vi.fn(),
    updateStrategy: vi.fn(),
    replaceStrategyDefinition: vi.fn(),
  };
});

const createStrategyMock = vi.mocked(createStrategy);

beforeEach(() => {
  createStrategyMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function strategyWith(definition: StrategyDefinition): StrategyDetailResponse {
  return {
    ownership: "USER",
    canEdit: true,
    id: "s-fundamentals",
    name: "Quality",
    buyLevelCount: definition.buyLevels.length,
    sellLevelCount: definition.sellLevels.length,
    hasFinalExit: definition.finalExit !== undefined,
    versionNumber: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    definition,
  };
}

function optionTexts(select: HTMLElement): (string | null)[] {
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

/** The text of a select's chosen option: what the user sees in the control. */
function shown(select: HTMLElement): string | null {
  const element = select as HTMLSelectElement;
  return element.options[element.selectedIndex]?.textContent ?? null;
}

/** The unit printed beside a numeric Value, or null when there is none. */
function unitBeside(value: HTMLElement): string | null {
  return (
    value.parentElement?.querySelector("[aria-hidden='true']")?.textContent ??
    null
  );
}

async function newBuyRow(user: ReturnType<typeof userEvent.setup>) {
  render(<StrategyBuilder />);
  await user.click(screen.getByTestId("add-level-BUY"));
  return screen.getByTestId("predicate-row");
}

describe("the Fundamentals category", () => {
  it("is offered once, after Valuation, in a Condition row and never in a Trigger row", async () => {
    const user = userEvent.setup();
    const row = await newBuyRow(user);
    const categories = optionTexts(
      within(row).getByTestId("metric-category-select"),
    );
    expect(categories.filter((label) => label === "Fundamentals")).toHaveLength(
      1,
    );
    expect(categories.indexOf("Fundamentals")).toBe(
      categories.indexOf("Valuation") + 1,
    );

    await user.click(screen.getByTestId("add-trigger"));
    const trigger = screen.getAllByTestId("metric-category-select").at(-1)!;
    expect(optionTexts(trigger)).not.toContain("Fundamentals");
  });

  it("lists the fifteen metrics in catalog order, each by its one label", async () => {
    const user = userEvent.setup();
    const row = await newBuyRow(user);
    await user.selectOptions(
      within(row).getByTestId("metric-category-select"),
      "FUNDAMENTALS",
    );
    expect(optionTexts(within(row).getByTestId("metric-select"))).toEqual(
      FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.label),
    );
    expect(optionTexts(within(row).getByTestId("metric-select"))).toEqual([
      "Revenue Growth TTM YoY",
      "EPS Growth TTM YoY",
      "FCF Growth TTM YoY",
      "Gross Margin TTM",
      "Operating Margin TTM",
      "Net Margin TTM",
      "FCF Margin TTM",
      "ROIC TTM",
      "ROE TTM",
      "ROA TTM",
      "Debt / Equity",
      "Current Ratio",
      "Net Debt / EBITDA TTM",
      "Interest Coverage TTM",
      "Asset Turnover TTM",
    ]);
    // Only the strict pair, and no Configure: the metric is the whole rule's identity.
    expect(optionTexts(within(row).getByTestId("operator-select"))).toEqual([
      "is above",
      "is below",
    ]);
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
  });
});

describe("a Fundamental row's Value", () => {
  it("takes percentage points for a percentage metric and a raw multiple for a ratio", async () => {
    const user = userEvent.setup();
    const row = await newBuyRow(user);
    await user.selectOptions(
      within(row).getByTestId("metric-category-select"),
      "FUNDAMENTALS",
    );

    // Revenue Growth TTM YoY: a percentage, floored at -100, starting at the neutral 0%.
    let value = within(row).getByTestId("value-control") as HTMLInputElement;
    expect(value.value).toBe("0");
    expect(unitBeside(value)).toBe("%");
    expect(value.getAttribute("min")).toBe("-100");
    expect(value.getAttribute("step")).toBe("any");
    await user.clear(value);
    await user.type(value, "12.5");
    expect(
      within(screen.getByTestId("logic-preview")).getByText(
        "Revenue Growth TTM YoY is above 12.5%",
      ),
    ).toBeDefined();

    // ROIC TTM: another percentage, so the threshold the user typed stays.
    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "FUNDAMENTAL:ROIC_TTM",
    );
    value = within(row).getByTestId("value-control") as HTMLInputElement;
    expect(value.value).toBe("12.5");
    expect(value.getAttribute("min")).toBeNull();
    expect(
      within(screen.getByTestId("logic-preview")).getByText(
        "ROIC TTM is above 12.5%",
      ),
    ).toBeDefined();

    // Debt / Equity: a raw multiple, so 12.5% cannot come along — it starts at 1.0x.
    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "FUNDAMENTAL:DEBT_TO_EQUITY",
    );
    value = within(row).getByTestId("value-control") as HTMLInputElement;
    expect(value.value).toBe("1");
    expect(unitBeside(value)).toBe("x");
    expect(value.getAttribute("min")).toBe("0");
    expect(value.getAttribute("step")).toBe("0.1");
    await user.selectOptions(
      within(row).getByTestId("operator-select"),
      "IS_BELOW",
    );
    await user.clear(value);
    await user.type(value, "0.75");
    // Printed exactly: never rounded to a different rule.
    expect(
      within(screen.getByTestId("logic-preview")).getByText(
        "Debt / Equity is below 0.75x",
      ),
    ).toBeDefined();

    // Net Debt / EBITDA is signed: net cash is a real threshold, so no floor is offered.
    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "FUNDAMENTAL:NET_DEBT_TO_EBITDA_TTM",
    );
    value = within(row).getByTestId("value-control") as HTMLInputElement;
    expect(value.getAttribute("min")).toBeNull();
    expect(value.value).toBe("0.75");
  });

  it("saves the rule as its stable identity, with the threshold as typed", async () => {
    const user = userEvent.setup();
    createStrategyMock.mockResolvedValue(
      strategyWith({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [],
        sellLevels: [],
      }),
    );
    render(<StrategyBuilder />);
    await user.type(screen.getByLabelText("Name"), "Quality compounders");
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await user.selectOptions(
      within(row).getByTestId("metric-category-select"),
      "FUNDAMENTALS",
    );
    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "FUNDAMENTAL:ROIC_TTM",
    );
    const value = within(row).getByTestId("value-control");
    await user.clear(value);
    await user.type(value, "15");
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(createStrategyMock).toHaveBeenCalledTimes(1));
    const saved = createStrategyMock.mock.calls[0]?.[0];
    expect(saved?.definition.buyLevels[0]?.signal.conditions[0]).toMatchObject({
      metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
      operator: "IS_ABOVE",
      value: { kind: "PERCENT", value: 15 },
    });
    expect(
      Object.keys(
        saved?.definition.buyLevels[0]?.signal.conditions[0]?.metric ?? {},
      ).sort(),
    ).toEqual(["kind", "metricId"]);
  });
});

describe("a saved Fundamental strategy in the Builder", () => {
  const SAVED = strategyWith({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "b1",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "c1",
              metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 15 },
            },
            {
              id: "c2",
              metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
              operator: "IS_BELOW",
              value: { kind: "MULTIPLE", value: 0.75 },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  });

  it("reads back exactly as it was saved, in every control and in the Strategy logic", () => {
    render(<StrategyBuilder strategy={SAVED} />);
    const [roic, leverage] = screen.getAllByTestId("predicate-row");
    expect(shown(within(roic!).getByTestId("metric-category-select"))).toBe(
      "Fundamentals",
    );
    expect(shown(within(roic!).getByTestId("metric-select"))).toBe("ROIC TTM");
    expect(shown(within(roic!).getByTestId("operator-select"))).toBe(
      "is above",
    );
    const roicValue = within(roic!).getByTestId(
      "value-control",
    ) as HTMLInputElement;
    expect(roicValue.value).toBe("15");
    expect(unitBeside(roicValue)).toBe("%");

    expect(shown(within(leverage!).getByTestId("metric-select"))).toBe(
      "Debt / Equity",
    );
    expect(shown(within(leverage!).getByTestId("operator-select"))).toBe(
      "is below",
    );
    const leverageValue = within(leverage!).getByTestId(
      "value-control",
    ) as HTMLInputElement;
    expect(leverageValue.value).toBe("0.75");
    expect(unitBeside(leverageValue)).toBe("x");

    const preview = screen.getByTestId("logic-preview");
    expect(within(preview).getByText("ROIC TTM is above 15%")).toBeDefined();
    expect(
      within(preview).getByText("Debt / Equity is below 0.75x"),
    ).toBeDefined();
    // Nothing a storage layer knows reaches the page.
    expect(screen.getByTestId("strategy-builder").textContent).not.toMatch(
      /roicTtm|debtToEquity|ROIC_TTM|DEBT_TO_EQUITY/,
    );
  });

  it("explains the focused metric from the catalog: its meaning, formula, unit and availability", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={SAVED} />);
    const [roic, leverage] = screen.getAllByTestId("predicate-row");
    const roicEntry = FUNDAMENTAL_METRIC_CATALOG.find(
      (entry) => entry.id === "ROIC_TTM",
    )!;

    await user.click(within(roic!).getByTestId("metric-select"));
    let panel = screen.getByTestId("explanation-panel");
    expect(within(panel).getByRole("heading").textContent).toBe("ROIC TTM");
    expect(within(panel).getByTestId("help-category").textContent).toBe(
      "Fundamentals",
    );
    expect(panel.textContent).toContain(roicEntry.summary);
    expect(within(panel).getByTestId("help-formula").textContent).toBe(
      roicEntry.formula,
    );
    expect(within(panel).getByTestId("help-notes").textContent).toContain(
      "percentage points",
    );
    expect(
      within(panel).getByTestId("help-not-evaluable").textContent,
    ).toContain("never zero");

    await user.click(within(leverage!).getByTestId("metric-select"));
    panel = screen.getByTestId("explanation-panel");
    expect(within(panel).getByRole("heading").textContent).toBe(
      "Debt / Equity",
    );
    expect(within(panel).getByTestId("help-notes").textContent).toContain(
      "raw multiple",
    );
  });

  it("shows the canonical refusal for a Fundamental Trigger a document carries", async () => {
    const user = userEvent.setup();
    render(
      <StrategyBuilder
        strategy={strategyWith({
          schemaVersion: STRATEGY_SCHEMA_VERSION,
          buyLevels: [
            {
              id: "b1",
              percentage: 50,
              signal: {
                conditions: [],
                trigger: {
                  id: "t1",
                  metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
                  operator: "CROSSES_ABOVE",
                  value: { kind: "PERCENT", value: 15 },
                },
              },
            },
          ],
          sellLevels: [],
        })}
      />,
    );
    const trigger = screen.getByTestId("predicate-row");
    // The Trigger row offers no Fundamentals, so the stored metric reads as unavailable rather
    // than silently as some other category.
    expect(shown(within(trigger).getByTestId("metric-category-select"))).toBe(
      "Unavailable category",
    );
    // A loaded document stays quiet until a field is touched (UI-013); touching the metric reveals
    // the validator's own words for the refusal.
    await user.click(within(trigger).getByTestId("metric-category-select"));
    await user.tab();
    expect(within(trigger).getByRole("alert").textContent).toBe(
      "ROIC TTM cannot be used as a trigger. Use it as a condition instead.",
    );
    expect(screen.getByTestId("save-strategy")).toHaveProperty(
      "disabled",
      true,
    );
  });
});
