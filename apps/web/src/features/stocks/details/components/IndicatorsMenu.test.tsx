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
import { seriesColor } from "../utils/chart-theme";
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
      colorOf={(id) => (selected.has(id) ? seriesColor(id) : undefined)}
    />
  );
}

/** Resolved by test id so the panel can be inspected while it is still hidden. */
function panel() {
  return screen.getByTestId("indicators-panel");
}

function valuationRadios(): HTMLInputElement[] {
  return within(within(panel()).getByTestId("valuation-section")).getAllByRole(
    "radio",
  ) as HTMLInputElement[];
}

function fundamentalRadios(): HTMLInputElement[] {
  return within(
    within(panel()).getByTestId("fundamentals-section"),
  ).getAllByRole("radio") as HTMLInputElement[];
}

/** The visible label of an option row: the text of the label element wrapping the input. */
function labelOf(input: HTMLInputElement): string {
  return input.closest("label")?.textContent ?? "";
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

    const legends = [
      ...panel().querySelectorAll(":scope > div > fieldset > legend"),
    ].map((legend) => legend.textContent);
    expect(legends).toEqual([
      ...SELECTABLE_SERIES_GROUPED.map((group) => group.label),
      "Valuation",
      "Fundamentals",
    ]);
    // Radio groups, so they add no checkbox: the overlay count is the catalog's alone.
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(
      SELECTABLE_SERIES_CATALOG.length,
    );
    // Exactly two radio groups: None plus the five ratios, None plus the fifteen metrics.
    const names = new Set(
      within(panel())
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLInputElement).name),
    );
    expect(names.size).toBe(2);
    expect(valuationRadios()).toHaveLength(1 + VALUATION_RATIO_IDS.length);
    expect(fundamentalRadios()).toHaveLength(1 + FUNDAMENTAL_METRIC_IDS.length);
  });

  it("lists the five valuation ratios by their catalog labels, with None first and chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const radios = valuationRadios();

    // Nothing is chosen, so nothing about a ratio is loaded.
    expect(radios[0]?.checked).toBe(true);
    expect(labelOf(radios[0]!)).toBe("None");
    // Written out by hand: a sixth ratio added to the catalog reaches this group and fails here,
    // so Stock Details' coverage of it is a deliberate change.
    expect(radios.slice(1).map(labelOf)).toEqual([
      "P/E",
      "P/S",
      "P/B",
      "P/FCF",
      "EV/EBITDA",
    ]);
    expect(radios.slice(1).map((radio) => radio.value)).toEqual([
      ...VALUATION_RATIO_IDS,
    ]);
    // Flat: the ratios have no groups of their own.
    expect(
      within(panel())
        .getByTestId("valuation-section")
        .querySelectorAll("fieldset"),
    ).toHaveLength(0);
  });

  it("chooses each catalog ratio by its own identity, never by its label", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseValuation={chosen} />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));

    for (const entry of VALUATION_RATIO_CATALOG) {
      const radios = valuationRadios().filter(
        (radio) => radio.value === entry.id,
      );
      expect(radios, entry.id).toHaveLength(1);
      expect(labelOf(radios[0]!)).toBe(entry.label);
      await user.click(radios[0]!);
      expect(chosen).toHaveBeenLastCalledWith(entry.id);
      // Exactly one checked: choosing another replaced the previous one.
      expect(
        valuationRadios()
          .filter((radio) => radio.checked)
          .map((radio) => radio.value),
      ).toEqual([entry.id]);
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
    const valuation = (id: string) =>
      valuationRadios().find((radio) => radio.value === id)!;
    const fundamental = (id: string) =>
      fundamentalRadios().find((radio) => radio.value === id)!;

    await user.click(valuation("PRICE_TO_EARNINGS_TTM"));
    // Balanced plus the ratio.
    expect(within(trigger).getByText("2")).toBeDefined();
    await user.click(valuation("PRICE_TO_BOOK"));
    expect(ratio).toHaveBeenLastCalledWith("PRICE_TO_BOOK");
    expect(within(trigger).getByText("2")).toBeDefined();

    await user.click(fundamental("ROIC_TTM"));
    expect(within(trigger).getByText("3")).toBeDefined();
    // Choosing a metric leaves the ratio as it was, and the other way round.
    expect(valuation("PRICE_TO_BOOK").checked).toBe(true);
    await user.click(valuation("EV_TO_EBITDA_TTM"));
    expect(fundamental("ROIC_TTM").checked).toBe(true);

    await user.click(valuation(""));
    expect(ratio).toHaveBeenLastCalledWith(null);
    expect(fundamental("ROIC_TTM").checked).toBe(true);
    expect(metric).toHaveBeenCalledTimes(1);
    expect(within(trigger).getByText("2")).toBeDefined();
  });

  it("explains the chosen ratio in its own catalog words, and nothing before one is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    expect(within(panel()).queryByTestId("valuation-help")).toBeNull();

    for (const entry of VALUATION_RATIO_CATALOG) {
      await user.click(
        valuationRadios().find((radio) => radio.value === entry.id)!,
      );
      const help = within(panel()).getByTestId("valuation-help");
      expect(help.textContent).toBe(`${entry.summary}${entry.formula}`);
    }
    // Neither help names the price-basis machinery behind the ratios.
    expect(panel().textContent).not.toMatch(/split|re-base|generation|basis/i);
  });

  it("lists every metric exactly once, grouped and ordered by the catalog, in one radio group", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const section = within(panel()).getByTestId("fundamentals-section");
    const radios = fundamentalRadios();

    // "None" first and chosen: nothing is loaded until a metric is.
    expect(radios[0]?.checked).toBe(true);
    expect(labelOf(radios[0]!)).toBe("None");

    const groups = [...section.querySelectorAll("fieldset")].map((group) => [
      group.querySelector("legend")?.textContent,
      [...group.querySelectorAll("input")].map((input) => input.value),
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
    const offered = radios.map((radio) => radio.value).filter(Boolean);
    expect(offered).toHaveLength(FUNDAMENTAL_METRIC_IDS.length);
    expect(new Set(offered)).toEqual(new Set(FUNDAMENTAL_METRIC_IDS));
    // One choice across every category, never one per category.
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
  });

  it("chooses each catalog metric by its own identity, label and group", async () => {
    // Exhaustive over the catalog: a metric added to it reaches this group, under its one label and
    // its own category, and choosing it hands exactly its identity to the page — never a label and
    // never anything that names how it is stored.
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseFundamental={chosen} />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));

    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const radios = fundamentalRadios().filter(
        (radio) => radio.value === entry.id,
      );
      expect(radios, entry.id).toHaveLength(1);
      const radio = radios[0] as HTMLInputElement;
      expect(labelOf(radio)).toBe(entry.label);
      expect(
        radio.closest("fieldset")?.querySelector("legend")?.textContent,
      ).toBe(FUNDAMENTAL_METRIC_GROUP_LABELS[entry.group]);

      await user.click(radio);
      expect(chosen).toHaveBeenLastCalledWith(entry.id);
      expect(
        fundamentalRadios()
          .filter((candidate) => candidate.checked)
          .map((candidate) => candidate.value),
      ).toEqual([entry.id]);
    }
    expect(chosen).toHaveBeenCalledTimes(FUNDAMENTAL_METRIC_CATALOG.length);
  });

  it("holds one metric at a time, counts it, and clears it with None", async () => {
    const user = userEvent.setup();
    const chosen = vi.fn();
    render(<Harness onChooseFundamental={chosen} />);
    const trigger = screen.getByRole("button", { name: /Indicators/ });
    await user.click(trigger);
    const radio = (id: string) =>
      fundamentalRadios().find((candidate) => candidate.value === id)!;

    await user.click(radio("ROIC_TTM"));
    // Balanced plus the fundamental.
    expect(within(trigger).getByText("2")).toBeDefined();
    // Another category's metric replaces it: one group across categories.
    await user.click(radio("DEBT_TO_EQUITY"));
    expect(chosen).toHaveBeenLastCalledWith("DEBT_TO_EQUITY");
    expect(radio("ROIC_TTM").checked).toBe(false);
    expect(within(trigger).getByText("2")).toBeDefined();

    await user.click(radio(""));
    expect(chosen).toHaveBeenLastCalledWith(null);
    expect(within(trigger).getByText("1")).toBeDefined();
  });

  it("explains the chosen metric in its own catalog words, and nothing before one is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    expect(within(panel()).queryByTestId("fundamental-help")).toBeNull();

    await user.click(
      fundamentalRadios().find((radio) => radio.value === "ROIC_TTM")!,
    );
    const roic = FUNDAMENTAL_METRIC_CATALOG.find(
      (entry) => entry.id === "ROIC_TTM",
    );
    const help = within(panel()).getByTestId("fundamental-help");
    expect(help.textContent).toContain(roic?.summary);
    expect(help.textContent).toContain(roic?.formula);
  });

  it("reaches each radio group with one Tab after the overlays, and moves through it with the arrow keys", async () => {
    const user = userEvent.setup();
    const ratio = vi.fn();
    const metric = vi.fn();
    render(
      <Harness
        initial={[]}
        onChooseValuation={ratio}
        onChooseFundamental={metric}
      />,
    );
    await user.tab();
    await user.keyboard("{Enter}");
    // One tab stop per overlay checkbox, then one for the valuation group's checked radio.
    for (let step = 0; step < SELECTABLE_SERIES_CATALOG.length + 1; step += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(valuationRadios()[0]);
    expect(
      within(panel())
        .getByTestId("valuation-section")
        .getAttribute("aria-describedby"),
    ).toBeTruthy();
    await user.keyboard("{ArrowDown}");
    expect(ratio).toHaveBeenLastCalledWith("PRICE_TO_EARNINGS_TTM");

    // The next Tab leaves the valuation group for the fundamentals group.
    await user.tab();
    expect(document.activeElement).toBe(fundamentalRadios()[0]);
    // The arrow keys cross category headings: the fifteen metrics are one group.
    for (let step = 0; step < 4; step += 1) {
      await user.keyboard("{ArrowDown}");
    }
    expect(metric).toHaveBeenLastCalledWith("GROSS_MARGIN_TTM");
    expect(
      fundamentalRadios().find((radio) => radio.value === "GROSS_MARGIN_TTM")
        ?.checked,
    ).toBe(true);
  });
});
