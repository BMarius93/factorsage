import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_GROUP_LABELS,
  FUNDAMENTAL_METRIC_IDS,
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
  VALUATION_RATIO_CATALOG,
  VALUATION_RATIO_IDS,
  type FundamentalMetricId,
  type SelectableSeriesId,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { overlayColorAt } from "../utils/chart-theme";
import { IndicatorsMenu } from "./IndicatorsMenu";

const ALL_IDS = new Set(
  SELECTABLE_SERIES_CATALOG.map((series) => series.id),
) as ReadonlySet<SelectableSeriesId>;

function Harness({
  available = ALL_IDS,
  initial = ["BALANCED"] as SelectableSeriesId[],
  initialFundamental = null,
  onChooseFundamental,
  onChooseValuation,
}: {
  available?: ReadonlySet<SelectableSeriesId>;
  initial?: SelectableSeriesId[];
  initialFundamental?: FundamentalMetricId | null;
  onChooseFundamental?: (id: FundamentalMetricId | null) => void;
  onChooseValuation?: (id: ValuationRatioId | null) => void;
}) {
  const [selected, setSelected] = useState(new Set(initial));
  const [fundamental, setFundamental] = useState(initialFundamental);
  const [valuation, setValuation] = useState<ValuationRatioId | null>(null);
  return (
    <IndicatorsMenu
      selected={selected}
      available={available}
      valuation={valuation}
      onChooseValuation={(id) => {
        onChooseValuation?.(id);
        setValuation(id);
      }}
      fundamental={fundamental}
      onChooseFundamental={(id) => {
        onChooseFundamental?.(id);
        setFundamental(id);
      }}
      onToggle={(id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        })
      }
      colorOf={(id) => (selected.has(id) ? overlayColorAt(0) : undefined)}
    />
  );
}

/** Resolved by test id so the panel can be inspected while it is still hidden. */
function panel() {
  return screen.getByTestId("indicators-panel");
}

describe("IndicatorsMenu", () => {
  it("is closed until the trigger is activated and reports the selection count", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: /Indicators/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(within(trigger).getByText("1")).toBeDefined();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("hidden")).toBe(false);
  });

  it("opens and toggles entirely from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Indicators/ }),
    );
    await user.keyboard("{Enter}");
    expect(panel().hasAttribute("hidden")).toBe(false);

    // Tab reaches the first option and Space toggles it, with no custom key handling needed.
    await user.tab();
    const first = document.activeElement as HTMLInputElement;
    expect(first.type).toBe("checkbox");
    await user.keyboard(" ");
    expect(first.checked).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: /Indicators/ });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a pointer press lands outside the control", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">Elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(panel().hasAttribute("hidden")).toBe(true);
  });

  it("keeps every catalog entry discoverable and disables only the unavailable ones", async () => {
    const user = userEvent.setup();
    const available = new Set<SelectableSeriesId>(["SMA_20D", "BALANCED"]);
    render(<Harness available={available} initial={["BALANCED"]} />);

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const options = within(panel()).getAllByRole("checkbox");

    // Counts follow from the catalog and this harness's `available` set, so a new catalog entry
    // does not require editing these numbers — only being genuinely rendered and disabled.
    const expectedDisabled = SELECTABLE_SERIES_CATALOG.length - available.size;
    expect(options).toHaveLength(SELECTABLE_SERIES_CATALOG.length);
    expect(
      options.filter((box) => (box as HTMLInputElement).disabled),
    ).toHaveLength(expectedDisabled);
    expect(within(panel()).getAllByText("Unavailable")).toHaveLength(
      expectedDisabled,
    );
    // An unavailable entry is present and identified, never removed or swapped for another.
    expect(
      within(panel()).getByRole("checkbox", { name: "SMA 200W Unavailable" }),
    ).toBeDefined();
  });

  it("supports several simultaneous selections", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    for (const name of ["SMA 50D", "EMA 200W", "Conservative", "Graham"]) {
      await user.click(within(panel()).getByRole("checkbox", { name }));
    }

    const checked = within(panel())
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(4);
    expect(
      within(screen.getByRole("button", { name: /Indicators/ })).getByText("4"),
    ).toBeDefined();
  });

  it("offers the Valuation and Fundamentals sections once each, in that order, after every overlay group", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));

    const legends = [...panel().querySelectorAll("legend")].map(
      (legend) => legend.textContent,
    );
    expect(legends).toEqual([
      ...SELECTABLE_SERIES_GROUPED.map((group) => group.label),
      "Valuation",
      "Fundamentals",
    ]);
    // Single-selects, so they add no checkbox: the overlay count is the catalog's alone.
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(
      SELECTABLE_SERIES_CATALOG.length,
    );
    expect(
      within(panel()).getAllByRole("combobox", { name: "Valuation ratio" }),
    ).toHaveLength(1);
    expect(
      within(panel()).getAllByRole("combobox", { name: "Fundamental metric" }),
    ).toHaveLength(1);
  });

  it("lists the five valuation ratios by their catalog labels, with None first and chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const select = within(panel()).getByRole("combobox", {
      name: "Valuation ratio",
    }) as HTMLSelectElement;

    // Nothing is chosen, so nothing about a ratio is loaded.
    expect(select.value).toBe("");
    expect(select.options[0]?.textContent).toBe("None");
    // Written out by hand: a sixth ratio added to the catalog reaches this select and fails here,
    // so Stock Details' coverage of it is a deliberate change.
    expect(
      [...select.options].slice(1).map((option) => option.textContent),
    ).toEqual(["P/E", "P/S", "P/B", "P/FCF", "EV/EBITDA"]);
    expect([...select.options].slice(1).map((option) => option.value)).toEqual([
      ...VALUATION_RATIO_IDS,
    ]);
    // Flat: the ratios have no groups of their own.
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
  });

  it("chooses each catalog ratio by its own identity, never by its label", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseValuation={chosen} />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const select = within(panel()).getByRole("combobox", {
      name: "Valuation ratio",
    }) as HTMLSelectElement;

    for (const entry of VALUATION_RATIO_CATALOG) {
      const options = [...select.options].filter(
        (option) => option.value === entry.id,
      );
      expect(options, entry.id).toHaveLength(1);
      expect(options[0]?.textContent).toBe(entry.label);
      await user.selectOptions(select, entry.id);
      expect(chosen).toHaveBeenLastCalledWith(entry.id);
      expect(select.value).toBe(entry.id);
    }
    expect(chosen).toHaveBeenCalledTimes(VALUATION_RATIO_CATALOG.length);
  });

  it("holds one ratio at a time beside one metric, counts both, and None clears only its own", async () => {
    const user = userEvent.setup();
    const ratio = vi.fn();
    const metric = vi.fn();
    render(<Harness onChooseValuation={ratio} onChooseFundamental={metric} />);
    const trigger = screen.getByRole("button", { name: /Indicators/ });
    await user.click(trigger);
    const valuation = within(panel()).getByRole("combobox", {
      name: "Valuation ratio",
    }) as HTMLSelectElement;
    const fundamental = within(panel()).getByRole("combobox", {
      name: "Fundamental metric",
    }) as HTMLSelectElement;

    await user.selectOptions(valuation, "PRICE_TO_EARNINGS_TTM");
    // Balanced plus the ratio.
    expect(within(trigger).getByText("2")).toBeDefined();
    await user.selectOptions(valuation, "PRICE_TO_BOOK");
    expect(ratio).toHaveBeenLastCalledWith("PRICE_TO_BOOK");
    expect(within(trigger).getByText("2")).toBeDefined();

    await user.selectOptions(fundamental, "ROIC_TTM");
    expect(within(trigger).getByText("3")).toBeDefined();
    // Choosing a metric leaves the ratio as it was, and the other way round.
    expect(valuation.value).toBe("PRICE_TO_BOOK");
    await user.selectOptions(valuation, "EV_TO_EBITDA_TTM");
    expect(fundamental.value).toBe("ROIC_TTM");

    await user.selectOptions(valuation, "");
    expect(ratio).toHaveBeenLastCalledWith(null);
    expect(fundamental.value).toBe("ROIC_TTM");
    expect(metric).toHaveBeenCalledTimes(1);
    expect(within(trigger).getByText("2")).toBeDefined();
  });

  it("explains the chosen ratio in its own catalog words, and nothing before one is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    expect(within(panel()).queryByTestId("valuation-help")).toBeNull();

    for (const entry of VALUATION_RATIO_CATALOG) {
      await user.selectOptions(
        within(panel()).getByRole("combobox", { name: "Valuation ratio" }),
        entry.id,
      );
      const help = within(panel()).getByTestId("valuation-help");
      expect(help.textContent).toBe(`${entry.summary}${entry.formula}`);
    }
    // Neither help names the price-basis machinery behind the ratios.
    expect(panel().textContent).not.toMatch(/split|re-base|generation|basis/i);
  });

  it("lists every metric exactly once, grouped and ordered by the catalog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const select = within(panel()).getByRole("combobox", {
      name: "Fundamental metric",
    }) as HTMLSelectElement;

    // "None" first and chosen: nothing is loaded until a metric is.
    expect(select.value).toBe("");
    expect(select.options[0]?.textContent).toBe("None");

    const groups = [...select.querySelectorAll("optgroup")].map((group) => [
      group.label,
      [...group.querySelectorAll("option")].map((option) => option.value),
    ]);
    expect(groups).toEqual([
      [
        "Growth",
        ["REVENUE_GROWTH_TTM_YOY", "EPS_GROWTH_TTM_YOY", "FCF_GROWTH_TTM_YOY"],
      ],
      [
        "Profitability",
        [
          "GROSS_MARGIN_TTM",
          "OPERATING_MARGIN_TTM",
          "NET_MARGIN_TTM",
          "FCF_MARGIN_TTM",
        ],
      ],
      ["Quality", ["ROIC_TTM", "ROE_TTM", "ROA_TTM"]],
      ["Leverage", ["DEBT_TO_EQUITY", "NET_DEBT_TO_EBITDA_TTM"]],
      ["Liquidity", ["CURRENT_RATIO"]],
      ["Solvency", ["INTEREST_COVERAGE_TTM"]],
      ["Efficiency", ["ASSET_TURNOVER_TTM"]],
    ]);
    const offered = [...select.options]
      .map((option) => option.value)
      .filter(Boolean);
    expect(offered).toHaveLength(FUNDAMENTAL_METRIC_IDS.length);
    expect(new Set(offered)).toEqual(new Set(FUNDAMENTAL_METRIC_IDS));
  });

  it("chooses each catalog metric by its own identity, label and group", async () => {
    // Exhaustive over the catalog: a metric added to it reaches this select, under its one label and
    // its own group, and choosing it hands exactly its identity to the page — never a label and never
    // anything that names how it is stored.
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseFundamental={chosen} />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const select = within(panel()).getByRole("combobox", {
      name: "Fundamental metric",
    }) as HTMLSelectElement;

    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const options = [...select.options].filter(
        (option) => option.value === entry.id,
      );
      expect(options, entry.id).toHaveLength(1);
      const option = options[0] as HTMLOptionElement;
      expect(option.textContent).toBe(entry.label);
      expect((option.parentElement as HTMLOptGroupElement).label).toBe(
        FUNDAMENTAL_METRIC_GROUP_LABELS[entry.group],
      );

      await user.selectOptions(select, entry.id);
      expect(chosen).toHaveBeenLastCalledWith(entry.id);
      expect(select.value).toBe(entry.id);
    }
    expect(chosen).toHaveBeenCalledTimes(FUNDAMENTAL_METRIC_CATALOG.length);
  });

  it("holds one metric at a time, counts it, and clears it with None", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseFundamental={chosen} />);
    const trigger = screen.getByRole("button", { name: /Indicators/ });
    await user.click(trigger);
    const select = within(panel()).getByRole("combobox", {
      name: "Fundamental metric",
    });

    await user.selectOptions(select, "ROIC_TTM");
    // Balanced plus the fundamental.
    expect(within(trigger).getByText("2")).toBeDefined();
    await user.selectOptions(select, "DEBT_TO_EQUITY");
    expect(chosen).toHaveBeenLastCalledWith("DEBT_TO_EQUITY");
    expect(within(trigger).getByText("2")).toBeDefined();

    await user.selectOptions(select, "");
    expect(chosen).toHaveBeenLastCalledWith(null);
    expect(within(trigger).getByText("1")).toBeDefined();
  });

  it("explains the chosen metric in its own catalog words, and nothing before one is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    expect(within(panel()).queryByTestId("fundamental-help")).toBeNull();

    await user.selectOptions(
      within(panel()).getByRole("combobox", { name: "Fundamental metric" }),
      "ROIC_TTM",
    );
    const roic = FUNDAMENTAL_METRIC_CATALOG.find(
      (entry) => entry.id === "ROIC_TTM",
    );
    const help = within(panel()).getByTestId("fundamental-help");
    expect(help.textContent).toContain(roic?.summary);
    expect(help.textContent).toContain(roic?.formula);
  });

  it("reaches the valuation and then the fundamental select from the keyboard, after the overlays", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    await user.tab();
    await user.keyboard("{Enter}");
    const valuation = within(panel()).getByRole("combobox", {
      name: "Valuation ratio",
    });
    const fundamental = within(panel()).getByRole("combobox", {
      name: "Fundamental metric",
    });
    // One tab stop per overlay checkbox, then the valuation select, then the fundamental one.
    for (let step = 0; step < SELECTABLE_SERIES_CATALOG.length + 1; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(valuation);
    expect(valuation.getAttribute("aria-describedby")).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(fundamental);
    expect(fundamental.getAttribute("aria-describedby")).toBeTruthy();
  });
});
