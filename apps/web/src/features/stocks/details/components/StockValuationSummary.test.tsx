import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ValuationSnapshot } from "../utils/valuation";
import { StockValuationSummary } from "./StockValuationSummary";

const AS_OF = "2026-10-16";

function blend(
  blendId: ValuationSnapshot["blends"][number]["blendId"],
  label: string,
  valuePerShare: number,
  currency = "USD",
) {
  return { blendId, label, valuePerShare, currency, valuationDate: AS_OF };
}

function model(
  id: ValuationSnapshot["models"][number]["model"],
  label: string,
  valuePerShare: number,
) {
  return {
    model: id,
    label,
    valuePerShare,
    currency: "USD",
    valuationDate: AS_OF,
  };
}

/** AAPL-like: the blends and the models on both sides of a close of 300, and one exact match. */
const SNAPSHOT: ValuationSnapshot = {
  asOfDate: AS_OF,
  blends: [
    blend("BALANCED", "Balanced", 200),
    blend("CONSERVATIVE", "Conservative", 400),
    blend("DIVIDEND", "Dividend", 300),
  ],
  models: [
    model("DCF_FCFF", "DCF (FCFF)", 250),
    model("RESIDUAL_INCOME", "Residual Income", 375),
    // Far from every other estimate; stated exactly like them.
    model("DDM", "Dividend Discount (DDM)", 12.6),
    model("GRAHAM", "Graham", 300),
  ],
};

const CLOSE = { value: 300, date: AS_OF };

function renderSummary(
  props: Partial<Parameters<typeof StockValuationSummary>[0]> = {},
) {
  render(
    <StockValuationSummary
      snapshot={SNAPSHOT}
      latestClose={CLOSE}
      currency="USD"
      {...props}
    />,
  );
  return screen
    .getByRole("heading", { name: "Intrinsic value" })
    .closest("section")!;
}

describe("StockValuationSummary", () => {
  it("says where the price sits against every blend and model, in words", () => {
    const section = renderSummary();

    const blends = within(
      within(section).getByRole("list", { name: "Blended intrinsic values" }),
    ).getAllByRole("listitem");
    expect(blends.map((tile) => tile.textContent)).toEqual([
      "Balanced$200.00Price 50.00% above value",
      "Conservative$400.00Price 25.00% below value",
      "Dividend$300.00Price equals value",
    ]);

    const models = within(section).getByLabelText("Intrinsic values by model");
    expect(
      [...models.querySelectorAll("dt")].map((label) => label.textContent),
    ).toEqual([
      "DCF (FCFF)",
      "Residual Income",
      "Dividend Discount (DDM)",
      "Graham",
    ]);
    expect(
      [...models.querySelectorAll("dd")].map((value) => value.textContent),
    ).toEqual([
      "$250.00Price 20.00% above value",
      "$375.00Price 20.00% below value",
      "$12.60Price 2,280.95% above value",
      "$300.00Price equals value",
    ]);
    expect(within(section).queryByText(/Price vs value/)).toBeNull();
  });

  it("keeps every comparison neutral and unflagged, however far a model sits from the rest", () => {
    const section = renderSummary();
    const chips = within(section).getAllByText(/^Price /);
    expect(chips).toHaveLength(7);
    // One presentation for all of them: the same chip, no tone, no outlier note.
    expect(new Set(chips.map((chip) => chip.className)).size).toBe(1);
    for (const chip of chips) {
      expect(chip.getAttribute("data-tone")).toBeNull();
    }
    expect(section.textContent).not.toMatch(/outlier|differs widely/i);
    expect(chips.map((chip) => chip.getAttribute("data-direction"))).toEqual([
      "above",
      "below",
      "equal",
      "above",
      "below",
      "above",
      "equal",
    ]);
  });

  it("explains the percentages once, on a button reachable by tap and keyboard", () => {
    const section = renderSummary();
    const buttons = within(section).getAllByRole("button", {
      name: "About price versus value",
    });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]!);

    expect(within(section).getByRole("tooltip").textContent).toBe(
      "Each percentage compares the latest closing price with that intrinsic-value estimate. It is not a forecast or an expected return.",
    );
  });

  it("offers no explanation when nothing is compared with the close", () => {
    // No close to compare with.
    const withoutClose = renderSummary({ latestClose: undefined });
    expect(within(withoutClose).queryByText(/^Price /)).toBeNull();
    expect(
      within(withoutClose).queryByRole("button", {
        name: "About price versus value",
      }),
    ).toBeNull();
    expect(withoutClose.textContent).toContain("Valuation as of Oct 16, 2026");
  });

  it("compares only same-currency estimates, and explains only when one is compared", () => {
    const section = renderSummary({
      snapshot: {
        asOfDate: AS_OF,
        blends: [blend("BALANCED", "Balanced", 200, "EUR")],
        models: [],
      },
    });
    expect(within(section).queryByText(/^Price /)).toBeNull();
    expect(
      within(section).queryByRole("button", {
        name: "About price versus value",
      }),
    ).toBeNull();
  });
});
