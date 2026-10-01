import {
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
 * Valuation Ratios in the Strategy Builder (`docs/decisions/valuation-ratios-v1.md`).
 *
 * The Builder holds no ratio list, label or rule of its own: the five ratios, their operators and
 * their Values all come from `@intrinsic/contracts`. The rule reads `P/E is below 15` and shows
 * nothing about how a ratio's availability is decided.
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
    id: "s-valuation",
    name: "Cheap",
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

/** The unit printed beside a numeric Value, or null when there is none. */
function unitBeside(value: HTMLElement): string | null {
  return (
    value.parentElement?.querySelector("[aria-hidden='true']")?.textContent ??
    null
  );
}

describe("Valuation Ratios in the Builder", () => {
  it("are offered in the Valuation category after Margin of Safety, by their labels alone", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await user.selectOptions(
      within(row).getByTestId("metric-category-select"),
      "VALUATION",
    );
    const metrics = optionTexts(within(row).getByTestId("metric-select"));
    expect(metrics.slice(-5)).toEqual([
      "P/E",
      "P/S",
      "P/B",
      "P/FCF",
      "EV/EBITDA",
    ]);

    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "VALUATION_RATIO:PRICE_TO_EARNINGS_TTM",
    );
    expect(optionTexts(within(row).getByTestId("operator-select"))).toEqual([
      "is above",
      "is below",
    ]);
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
    const value = within(row).getByTestId("value-control") as HTMLInputElement;
    expect(unitBeside(value)).toBe("x");
    expect(value.getAttribute("min")).toBe("0");

    // A Trigger row does not offer them.
    await user.click(screen.getByTestId("add-trigger"));
    await user.selectOptions(
      screen.getAllByTestId("metric-category-select").at(-1)!,
      "VALUATION",
    );
    expect(
      optionTexts(screen.getAllByTestId("metric-select").at(-1)!),
    ).not.toContain("P/E");
  });

  it("saves `P/E is below 15` as the ratio's stable identity and a multiple", async () => {
    const user = userEvent.setup();
    createStrategyMock.mockResolvedValue(
      strategyWith({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [],
        sellLevels: [],
      }),
    );
    render(<StrategyBuilder />);
    await user.type(screen.getByLabelText("Name"), "Cheap earnings");
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await user.selectOptions(
      within(row).getByTestId("metric-category-select"),
      "VALUATION",
    );
    await user.selectOptions(
      within(row).getByTestId("metric-select"),
      "VALUATION_RATIO:PRICE_TO_EARNINGS_TTM",
    );
    await user.selectOptions(
      within(row).getByTestId("operator-select"),
      "IS_BELOW",
    );
    const value = within(row).getByTestId("value-control");
    await user.clear(value);
    await user.type(value, "15");
    expect(
      within(screen.getByTestId("logic-preview")).getByText(
        "P/E is below 15.0x",
      ),
    ).toBeDefined();
    await user.click(screen.getByTestId("save-strategy"));

    await waitFor(() => expect(createStrategyMock).toHaveBeenCalledTimes(1));
    const saved = createStrategyMock.mock.calls[0]?.[0];
    expect(saved?.definition.buyLevels[0]?.signal.conditions[0]).toMatchObject({
      metric: { kind: "VALUATION_RATIO", ratioId: "PRICE_TO_EARNINGS_TTM" },
      operator: "IS_BELOW",
      value: { kind: "MULTIPLE", value: 15 },
    });
  });
});
