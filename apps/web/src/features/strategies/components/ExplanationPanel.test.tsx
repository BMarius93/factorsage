import type { StrategyDefinition } from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StrategyBuilder } from "./StrategyBuilder";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

function strategyWith(definition: StrategyDefinition) {
  return {
    id: "s1",
    name: "Explained",
    buyLevelCount: definition.buyLevels.length,
    sellLevelCount: definition.sellLevels.length,
    hasFinalExit: definition.finalExit !== undefined,
    versionNumber: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    definition,
  };
}

const MOS_STRATEGY = strategyWith({
  schemaVersion: 1,
  buyLevels: [
    {
      id: "buy-1",
      percentage: 25,
      signal: {
        conditions: [
          {
            id: "c1",
            metric: { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 25 },
          },
        ],
        trigger: {
          id: "t1",
          metric: { kind: "PRICE" },
          operator: "CROSSES_ABOVE",
          value: { kind: "SERIES", seriesId: "EMA_50D" },
        },
      },
    },
  ],
  sellLevels: [
    {
      id: "sell-1",
      percentage: 50,
      signal: {
        conditions: [
          {
            id: "c2",
            metric: { kind: "GAIN" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 25 },
          },
        ],
      },
    },
  ],
  finalExit: {
    id: "exit-1",
    signal: {
      conditions: [],
      trigger: {
        id: "t2",
        metric: { kind: "PRICE" },
        operator: "CROSSES_BELOW",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
    },
  },
});

describe("explanation panel", () => {
  it("explains Margin of Safety with Intrinsic Value as the denominator", () => {
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);
    const panel = screen.getByTestId("explanation-panel");

    expect(within(panel).getByText(/Margin of Safety \(DCF \(FCFF\)\)/)).toBeDefined();
    expect(within(panel).getByTestId("help-formula").textContent).toBe(
      "Margin of Safety = (Intrinsic Value - Price) / Intrinsic Value * 100",
    );
  });

  it("shows the canonical worked example and the distinction from upside", () => {
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);
    const panel = screen.getByTestId("explanation-panel");

    const examples = within(panel).getByTestId("help-examples");
    expect(examples.textContent).toContain("Intrinsic Value 100, Price 75");
    expect(examples.textContent).toContain("25%");
    // Positive, zero and negative are all covered.
    expect(examples.textContent).toContain("0%");
    expect(examples.textContent).toContain("-20%");
    expect(examples.textContent).toContain("below the intrinsic value");
    expect(examples.textContent).toContain("above the intrinsic value");

    const notes = within(panel).getByTestId("help-notes").textContent ?? "";
    expect(notes).toContain("not upside");
    expect(notes).toContain("33.33%");
    expect(notes).toContain("never Price");
  });

  it("states when Margin of Safety cannot be evaluated at all", () => {
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);
    const notEvaluable = within(
      screen.getByTestId("explanation-panel"),
    ).getByTestId("help-not-evaluable").textContent;
    expect(notEvaluable).toContain("zero or negative");
  });

  it("follows the focused control", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);

    const operator = within(screen.getByTestId("level-card-BUY")).getAllByTestId(
      "operator-select",
    )[0];
    await user.click(operator!);
    const panel = screen.getByTestId("explanation-panel");
    expect(within(panel).getByText("is above")).toBeDefined();
    expect(panel.textContent).toContain("strictly greater than");
  });

  it("explains a trigger as an event rather than a state", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);

    const buyCard = screen.getByTestId("level-card-BUY");
    const operators = within(buyCard).getAllByTestId("operator-select");
    await user.click(operators[operators.length - 1]!);

    const panel = screen.getByTestId("explanation-panel");
    expect(within(panel).getByText("crosses above")).toBeDefined();
    expect(panel.textContent).toContain("transition");
  });

  it("renders the whole strategy in words, keeping AND before the trigger", () => {
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);
    const preview = screen.getByTestId("logic-preview");
    const lines = within(preview)
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim());

    expect(lines).toEqual([
      "BUY 1 · 25% of a full position",
      "Margin of Safety (DCF (FCFF)) is above 25%",
      "AND Price crosses above EMA 50D (trigger)",
      "SELL 1 · 50% of the remaining position",
      "Gain is above 25%",
      "FINAL EXIT",
      "Price crosses below SMA 200D (trigger)",
    ]);
  });

  it("shows an incomplete level instead of silently omitting it", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);

    const buyCard = screen.getByTestId("level-card-BUY");
    await user.click(
      within(buyCard).getByRole("button", { name: "Remove condition 1" }),
    );
    await user.click(within(buyCard).getByRole("button", { name: "Remove trigger" }));

    expect(screen.getByTestId("logic-preview").textContent).toContain(
      "No conditions or trigger yet",
    );
  });

  it("describes the signal and never the backtest lifecycle", () => {
    render(<StrategyBuilder strategy={MOS_STRATEGY} />);
    const text = screen.getByTestId("strategy-explanation").textContent ?? "";
    // Level repetition, SELL vs FINAL EXIT precedence and candidate ordering are open decisions;
    // help must not present any of them as established behaviour.
    for (const forbidden of [
      /fires? (only )?once/i,
      /precedence/i,
      /candidate/i,
      /portfolio/i,
      /maximum positions/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});
