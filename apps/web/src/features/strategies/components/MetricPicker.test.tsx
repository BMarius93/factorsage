import {
  STRATEGY_ETF_SOURCE_GROUPS,
  STRATEGY_ETF_SOURCES,
  STRATEGY_LEVEL_KINDS,
  STRATEGY_PREDICATE_PARTS,
  strategyMetricFamilies,
  strategyMetricKey,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricSource,
  type StrategyPredicatePart,
} from "@intrinsic/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MetricPicker } from "./MetricPicker";
import {
  activeCategory,
  activeFamily,
  categoryLabels,
  chooseEtf,
  chooseSource,
  etfSelect,
  familyLabels,
  optionLabels,
  showCategory,
  showFamily,
  shownSource,
} from "./__testing__/operand-picker";

const XLK: StrategyMetricSource = { kind: "ETF", code: "ETF_XLK" };
const RSI_14D: StrategyMetric = { kind: "OSCILLATOR", seriesId: "RSI_14D" };

/** A picker holding its own metric, as a rule row holds it. */
function Harness({
  initial,
  levelKind = "BUY",
  part = "CONDITION",
  notice = null,
  onChange = () => {},
}: {
  readonly initial: StrategyMetric;
  readonly levelKind?: StrategyLevelKind;
  readonly part?: StrategyPredicatePart;
  readonly notice?: string | null;
  readonly onChange?: (metric: StrategyMetric) => void;
}) {
  const [metric, setMetric] = useState(initial);
  return (
    <div>
      <button type="button">Before</button>
      <MetricPicker
        levelKind={levelKind}
        part={part}
        metric={metric}
        label="Metric"
        invalid={false}
        notice={notice}
        onChange={(next) => {
          onChange(next);
          setMetric(next);
        }}
        onFocus={() => {}}
        onBlur={() => {}}
      />
      <button type="button">After</button>
    </div>
  );
}

const trigger = () => screen.getByTestId("metric-picker");
const panel = () => screen.queryByTestId("metric-picker-panel");

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return panel()!;
}

function pressedOptions(container: HTMLElement): string[] {
  return within(container)
    .queryAllByTestId("metric-picker-option")
    .filter((option) => option.getAttribute("aria-pressed") === "true")
    .map((option) => option.getAttribute("data-value") ?? "");
}

function optionKeys(container: HTMLElement): string[] {
  return within(container)
    .queryAllByTestId("metric-picker-option")
    .map((option) => option.getAttribute("data-value") ?? "");
}

describe("the Metric picker's library", () => {
  it("offers exactly the registry's families, subgroups and metrics for every level kind and half of a Signal", async () => {
    const user = userEvent.setup();
    for (const levelKind of STRATEGY_LEVEL_KINDS) {
      for (const part of STRATEGY_PREDICATE_PARTS) {
        const view = render(
          <Harness initial={{ kind: "PRICE" }} levelKind={levelKind} part={part} />,
        );
        const shown = await open(user);
        const expected = strategyMetricFamilies(levelKind, part);
        expect(familyLabels(shown)).toEqual(
          expected.map((family) => family.label),
        );
        for (const family of expected) {
          await showFamily(user, shown, family.id);
          // Several categories are subgroups; a single one lists its metrics with no header.
          expect(categoryLabels(shown)).toEqual(
            family.categories.length > 1
              ? family.categories.map((category) => category.label)
              : [],
          );
          for (const category of family.categories) {
            await showCategory(user, shown, category.id);
            expect(activeCategory(shown)).toBe(category.id);
            expect(optionKeys(shown)).toEqual(
              category.options.map((option) => strategyMetricKey(option.metric)),
            );
            expect(optionLabels(shown)).toEqual(
              category.options.map((option) => option.label),
            );
          }
        }
        view.unmount();
      }
    }
  });

  it("opens on the rule's own family and subgroup with its metric marked and focused", async () => {
    const user = userEvent.setup();
    render(<Harness initial={RSI_14D} />);
    const shown = await open(user);
    expect(shownSource(shown)).toBe("STOCK");
    expect(activeFamily(shown)).toBe("TECHNICAL");
    expect(activeCategory(shown)).toBe("OSCILLATORS");
    expect(pressedOptions(shown)).toEqual(["OSCILLATOR:RSI_14D"]);
    expect(document.activeElement?.getAttribute("data-value")).toBe(
      "OSCILLATOR:RSI_14D",
    );
  });

  it("keeps Technical compact: one subgroup open at a time, and Price a single row", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ kind: "PRICE" }} />);
    const shown = await open(user);
    const headers = () => within(shown).getAllByTestId("metric-picker-category");
    const expanded = () =>
      headers()
        .filter((header) => header.getAttribute("aria-expanded") === "true")
        .map((header) => header.getAttribute("data-value"));

    // Price is one option under one open header: three closed headers and one row, never a
    // panel sized for the longest family.
    expect(expanded()).toEqual(["PRICE"]);
    expect(optionLabels(shown)).toEqual(["Price"]);
    // A closed subgroup says how many metrics it holds.
    expect(
      headers().map((header) => header.textContent?.replace(/\s+/g, " ")),
    ).toEqual(["Price1", "Moving averages14", "Oscillators3", "Volume3"]);

    // Opening another closes the first; the list never holds two subgroups' metrics.
    await showCategory(user, shown, "MOVING_AVERAGES");
    expect(expanded()).toEqual(["MOVING_AVERAGES"]);
    expect(optionLabels(shown)).toHaveLength(14);

    // And the open one closes on a second press, leaving four lines.
    await user.click(
      headers().find(
        (header) => header.getAttribute("data-value") === "MOVING_AVERAGES",
      )!,
    );
    expect(expanded()).toEqual([]);
    expect(optionLabels(shown)).toEqual([]);
  });

  it("browses families and subgroups without changing anything, and marks where the rule lives", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={RSI_14D} onChange={onChange} />);
    const shown = await open(user);
    await showFamily(user, shown, "FUNDAMENTALS");
    expect(activeFamily(shown)).toBe("FUNDAMENTALS");
    expect(pressedOptions(shown)).toEqual([]);
    expect(
      within(shown)
        .getAllByTestId("metric-picker-family")
        .filter((tab) => tab.getAttribute("data-current") === "true")
        .map((tab) => tab.getAttribute("data-value")),
    ).toEqual(["TECHNICAL"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("RSI 14D");
  });

  it("chooses a metric, closes, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ kind: "PRICE" }} onChange={onChange} />);
    const shown = await open(user);
    await showCategory(user, shown, "INSIDER_ACTIVITY");
    await user.click(within(shown).getByText("Insider sellers"));
    // The registry's own instance, at its default configuration.
    expect(onChange).toHaveBeenCalledWith({
      kind: "INSIDER_ACTIVITY",
      measure: "SELLERS",
      lookback: 20,
    });
    expect(panel()).toBeNull();
    expect(trigger().textContent).toBe("Insider sellers");
    expect(document.activeElement).toBe(trigger());
  });

  it("does not report the rule's own metric chosen again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={RSI_14D} onChange={onChange} />);
    const shown = await open(user);
    await user.click(within(shown).getByText("RSI 14D"));
    expect(onChange).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("keeps a configured metric selected: its identity, not its configuration, is the choice", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          kind: "CONGRESS_ACTIVITY",
          measure: "SALES",
          lookback: 180,
          scope: { kind: "ANY" },
          chamber: "SENATE",
        }}
      />,
    );
    expect(trigger().textContent).toBe("Congress sales");
    const shown = await open(user);
    expect(activeFamily(shown)).toBe("ACTIVITY");
    expect(activeCategory(shown)).toBe("CONGRESSIONAL_TRADING");
    expect(pressedOptions(shown)).toEqual(["CONGRESS_ACTIVITY:SALES"]);
  });

  it("reads a metric the level no longer offers as unavailable, never as another metric", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ kind: "GAIN" }} levelKind="BUY" />);
    expect(trigger().textContent).toBe("Unavailable metric");
    const shown = await open(user);
    // Position is not a BUY family, so the popover opens on the first one with nothing marked.
    expect(familyLabels(shown)).not.toContain("Position");
    expect(activeFamily(shown)).toBe("TECHNICAL");
    expect(pressedOptions(shown)).toEqual([]);
  });

  it("keeps Position findable where a position exists", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ kind: "GAIN" }} levelKind="SELL" />);
    expect(trigger().textContent).toBe("Gain");
    const shown = await open(user);
    expect(familyLabels(shown)).toEqual([
      "Technical",
      "Fundamentals",
      "Valuation",
      "Activity",
      "Position",
    ]);
    expect(activeFamily(shown)).toBe("POSITION");
    expect(optionLabels(shown)).toEqual(["Gain", "Loss"]);
  });
});

describe("the Metric picker's data source", () => {
  it("defaults to Stock, with no ETF select until an ETF is the source", async () => {
    const user = userEvent.setup();
    render(<Harness initial={RSI_14D} />);
    const shown = await open(user);
    expect(shownSource(shown)).toBe("STOCK");
    expect(etfSelect(shown)).toBeNull();
    expect(
      within(shown).getByRole("radiogroup", { name: "Data source" }),
    ).toBeDefined();
  });

  it("lists the twenty funds under the decision's three groups, each by ticker and market", async () => {
    const user = userEvent.setup();
    render(<Harness initial={RSI_14D} />);
    const shown = await open(user);
    await chooseSource(user, shown, "ETF");
    const select = etfSelect(shown)!;
    const groups = [...select.querySelectorAll("optgroup")];
    // `Sectors`, as the decision names the group (owner ruling, 2026-10-14) — not the
    // Dashboard's `Sector Performance` heading, which stays the catalog's.
    expect(groups.map((group) => group.label)).toEqual([
      "Benchmarks",
      "Sectors",
      "Macro & Alternatives",
    ]);
    expect(groups.map((group) => group.label)).toEqual(
      STRATEGY_ETF_SOURCE_GROUPS.map((group) => group.pickerLabel),
    );
    expect(groups.map((group) => group.querySelectorAll("option").length)).toEqual(
      [5, 11, 4],
    );
    const options = [...select.querySelectorAll("option")];
    expect(options).toHaveLength(20);
    expect(options.map((option) => option.value)).toEqual(
      STRATEGY_ETF_SOURCES.map((etf) => etf.code),
    );
    expect(options.map((option) => option.textContent)).toEqual(
      STRATEGY_ETF_SOURCES.map((etf) => `${etf.ticker} — ${etf.label}`),
    );
  });

  it("moves a technical rule to an ETF at once, keeping its metric, and stays open", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={RSI_14D} onChange={onChange} />);
    const shown = await open(user);
    await chooseSource(user, shown, "ETF");
    // The catalog's first fund until one is chosen: SPY, stored as the SP500 series it is.
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: { kind: "ETF", code: "SP500" },
    });
    expect(panel()).not.toBeNull();
    expect(etfSelect(shown)!.value).toBe("SP500");
    expect(trigger().textContent).toBe("SPY · RSI 14D");
    // The metric is still the one marked, now under the ETF.
    expect(pressedOptions(shown)).toEqual(["ETF(SP500)|OSCILLATOR:RSI_14D"]);

    await chooseEtf(user, shown, "ETF_XLK");
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "OSCILLATOR",
      seriesId: "RSI_14D",
      source: XLK,
    });
    expect(trigger().textContent).toBe("XLK · RSI 14D");
    expect(trigger().getAttribute("data-value")).toBe(
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );
    expect(trigger().getAttribute("aria-label")).toBe("Metric: XLK · RSI 14D");
  });

  it("offers an ETF Technical alone: the registry's 21 technical metrics, and nothing else", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...RSI_14D, source: XLK }} levelKind="SELL" />);
    const shown = await open(user);
    expect(shownSource(shown)).toBe("ETF");
    expect(etfSelect(shown)!.value).toBe("ETF_XLK");
    // Position, Fundamentals, Valuation and Activity are stock families, absent — not disabled.
    expect(familyLabels(shown)).toEqual(["Technical"]);
    expect(categoryLabels(shown)).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Volume",
    ]);
    const keys: string[] = [];
    for (const category of ["PRICE", "MOVING_AVERAGES", "OSCILLATORS", "VOLUME"]) {
      await showCategory(user, shown, category);
      keys.push(...optionKeys(shown));
    }
    expect(keys).toHaveLength(21);
    expect(keys.every((key) => key.startsWith("ETF(ETF_XLK)|"))).toBe(true);
    // Inside the picker the ETF is named once, by the select; an option is the metric's identity.
    await showCategory(user, shown, "OSCILLATORS");
    expect(optionLabels(shown)).toEqual(["RSI 7D", "RSI 14D", "RSI 21D"]);
  });

  it("can read every one of the twenty funds, keeping the metric each time", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ kind: "PRICE" }} onChange={onChange} />);
    const shown = await open(user);
    await chooseSource(user, shown, "ETF");
    for (const etf of STRATEGY_ETF_SOURCES) {
      await chooseEtf(user, shown, etf.code);
      expect(trigger().textContent).toBe(`${etf.ticker} · Price`);
      expect(trigger().getAttribute("data-value")).toBe(`ETF(${etf.code})|PRICE:`);
    }
    // Nineteen changes after the first: choosing the fund already shown changes nothing.
    expect(onChange).toHaveBeenCalledTimes(20);
  });

  it("returns a rule to the stock with the same metric and no source at all", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ ...RSI_14D, source: XLK }} onChange={onChange} />);
    const shown = await open(user);
    await chooseSource(user, shown, "STOCK");
    expect(onChange).toHaveBeenLastCalledWith(RSI_14D);
    expect(Object.keys(onChange.mock.lastCall![0] as object)).not.toContain(
      "source",
    );
    expect(trigger().textContent).toBe("RSI 14D");
    expect(etfSelect(shown)).toBeNull();
    // The stock's whole library is back.
    expect(familyLabels(shown)).toContain("Fundamentals");
  });

  it("remembers the fund while the source is toggled, rather than starting over", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...RSI_14D, source: XLK }} />);
    const shown = await open(user);
    await chooseSource(user, shown, "STOCK");
    await chooseSource(user, shown, "ETF");
    expect(etfSelect(shown)!.value).toBe("ETF_XLK");
    expect(trigger().textContent).toBe("XLK · RSI 14D");
  });

  it("changes nothing for a stock-only metric until a metric of the ETF is chosen, and says so", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ kind: "FUNDAMENTAL", metricId: "ROIC_TTM" }}
        onChange={onChange}
      />,
    );
    const shown = await open(user);
    await chooseSource(user, shown, "ETF");
    // A Fundamental has no ETF form, so nothing was substituted for it.
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("ROIC TTM");
    const hint = within(shown).getByTestId("metric-picker-hint");
    expect(hint.textContent).toBe(
      "ROIC TTM is read from the stock only. Choose a metric below to read SPY instead.",
    );
    expect(hint.getAttribute("role")).toBe("status");
    expect(familyLabels(shown)).toEqual(["Technical"]);
    expect(pressedOptions(shown)).toEqual([]);

    // The fund can still be chosen first; it is part of the choice being made.
    await chooseEtf(user, shown, "ETF_GLD");
    expect(onChange).not.toHaveBeenCalled();
    expect(within(shown).getByTestId("metric-picker-hint").textContent).toContain(
      "to read GLD instead",
    );

    await showCategory(user, shown, "VOLUME");
    await user.click(within(shown).getByText("RVOL 20"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      kind: "RELATIVE_VOLUME",
      period: 20,
      source: { kind: "ETF", code: "ETF_GLD" },
    });
    expect(panel()).toBeNull();
    expect(trigger().textContent).toBe("GLD · RVOL 20");
  });

  it("reopens on the rule's own source after a browse that chose nothing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ kind: "FUNDAMENTAL", metricId: "ROIC_TTM" }}
        onChange={onChange}
      />,
    );
    let shown = await open(user);
    await chooseSource(user, shown, "ETF");
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    shown = await open(user);
    expect(shownSource(shown)).toBe("STOCK");
    expect(activeFamily(shown)).toBe("FUNDAMENTALS");
    expect(pressedOptions(shown)).toEqual(["FUNDAMENTAL:ROIC_TTM"]);
  });

  it("offers a Trigger no ETF: the choice is shown disabled, with the reason", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ kind: "PRICE" }} part="TRIGGER" onChange={onChange} />);
    const shown = await open(user);
    const etf = within(shown)
      .getAllByTestId("metric-picker-source")
      .find((radio) => radio.getAttribute("data-value") === "ETF") as HTMLInputElement;
    expect(etf.disabled).toBe(true);
    const hint = within(shown).getByTestId("metric-picker-hint");
    expect(hint.textContent).toBe(
      "An ETF can be read by a condition only, not by a trigger.",
    );
    expect(
      within(shown).getByRole("radiogroup").getAttribute("aria-describedby"),
    ).toBe(hint.id);
    await user.click(etf);
    expect(onChange).not.toHaveBeenCalled();
    expect(shownSource(shown)).toBe("STOCK");
  });

  it("prints what a change of source replaced where it can be seen, while the popover is open", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness initial={{ kind: "PRICE" }} />);
    const shown = await open(user);
    // Nothing was moved yet, so a notice left over from an earlier edit is not repeated here.
    rerender(
      <Harness initial={{ kind: "PRICE" }} notice="Value was reset to match Price." />,
    );
    expect(within(shown).queryByTestId("metric-picker-hint")).toBeNull();
    await chooseSource(user, shown, "ETF");
    rerender(
      <Harness
        initial={{ kind: "PRICE" }}
        notice="Value was reset to match SPY · Price."
      />,
    );
    const hint = within(shown).getByTestId("metric-picker-hint");
    expect(hint.textContent).toBe("Value was reset to match SPY · Price.");
    // The row's own line is the live region; this copy is for the eye only.
    expect(hint.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the Metric picker's keyboard", () => {
  it("opens with an arrow key, and closes on Escape with focus back on the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness initial={RSI_14D} />);
    act(() => trigger().focus());
    await user.keyboard("{ArrowDown}");
    expect(panel()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("walks the families with the arrow keys, showing each as it takes focus", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ kind: "PRICE" }} />);
    const shown = await open(user);
    const tabs = within(shown).getAllByRole("tab");
    // One tab stop: only the shown family is in the Tab order.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    act(() => tabs[0]!.focus());
    await user.keyboard("{ArrowRight}");
    expect(activeFamily(shown)).toBe("FUNDAMENTALS");
    expect(document.activeElement).toBe(tabs[1]);
    await user.keyboard("{End}");
    expect(activeFamily(shown)).toBe("ACTIVITY");
    await user.keyboard("{ArrowRight}");
    expect(activeFamily(shown)).toBe("TECHNICAL");
    await user.keyboard("{ArrowLeft}");
    expect(activeFamily(shown)).toBe("ACTIVITY");
    await user.keyboard("{Home}");
    expect(activeFamily(shown)).toBe("TECHNICAL");
    expect(within(shown).getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      tabs[0]!.id,
    );
  });

  it("walks the library with the arrow keys, opening and closing subgroups from their headers", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ kind: "PRICE" }} onChange={onChange} />);
    const shown = await open(user);
    const header = (id: string) =>
      within(shown)
        .getAllByTestId("metric-picker-category")
        .find((candidate) => candidate.getAttribute("data-value") === id)!;
    // Focus opens on the rule's metric; up is its subgroup's header.
    expect(document.activeElement?.getAttribute("data-value")).toBe("PRICE:");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(header("PRICE"));
    // Down again is the option, then the next header.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-value")).toBe("PRICE:");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(header("MOVING_AVERAGES"));
    // Right opens the subgroup under focus, and its first metric is one step down.
    await user.keyboard("{ArrowRight}");
    expect(header("MOVING_AVERAGES").getAttribute("aria-expanded")).toBe("true");
    expect(header("PRICE").getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-value")).toBe(
      "MOVING_AVERAGE:SMA_20D",
    );
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("data-value")).toBe(
      "MOVING_AVERAGE:SMA_50D",
    );
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(header("VOLUME"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(header("PRICE"));
    // Left closes an open subgroup from its header.
    act(() => header("MOVING_AVERAGES").focus());
    await user.keyboard("{ArrowLeft}");
    expect(header("MOVING_AVERAGES").getAttribute("aria-expanded")).toBe("false");
    // Enter on a metric is the choice.
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith({
      kind: "MOVING_AVERAGE",
      seriesId: "SMA_20D",
    });
    expect(document.activeElement).toBe(trigger());
  });

  it("names every level for a screen reader", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...RSI_14D, source: XLK }} />);
    const shown = await open(user);
    expect(shown.getAttribute("role")).toBe("dialog");
    expect(shown.getAttribute("aria-label")).toBe("Metric");
    expect(within(shown).getByRole("radio", { name: "Stock" })).toBeDefined();
    expect(
      (within(shown).getByRole("radio", { name: "ETF" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(shown).getByRole("combobox", { name: "ETF" })).toBeDefined();
    expect(
      within(shown).getByRole("tablist", { name: "Metric families" }),
    ).toBeDefined();
    const oscillators = within(shown).getByRole("button", {
      name: "Oscillators",
    });
    expect(oscillators.getAttribute("aria-expanded")).toBe("true");
    // The open subgroup's list is named by its header.
    const list = document.getElementById(
      oscillators.getAttribute("aria-controls")!,
    )!;
    expect(list.getAttribute("aria-labelledby")).toBe(oscillators.id);
    expect(
      within(list).getByRole("button", { name: "RSI 14D", pressed: true }),
    ).toBeDefined();
  });
});

/**
 * The compact, content-sized layout, asserted as declarations: jsdom has no layout, and each rule is
 * decided by a single declaration. The browser suite measures the same rules rendered.
 */
describe("the Metric picker's layout", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "MetricPicker.module.css"),
    "utf8",
  );
  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} is declared`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  }

  it("scrolls the library alone: the source and the families never move", () => {
    expect(ruleBody(".library")).toContain("overflow-y: auto");
    expect(ruleBody(".library")).toContain("min-height: 0");
    expect(ruleBody(".library")).toContain("flex: 1 1 auto");
    for (const fixed of [".source", ".families", ".hint"]) {
      expect(ruleBody(fixed)).toContain("flex: none");
      expect(ruleBody(fixed)).not.toContain("overflow");
    }
  });

  it("holds nothing at a fixed height, so a one-metric subgroup is one row", () => {
    // Minimum heights are touch targets; a `height` on anything that lays the panel out would be a
    // panel held open as blank space.
    for (const selector of [
      ".source",
      ".families",
      ".family",
      ".library",
      ".subgroup",
      ".subgroupHeader",
    ]) {
      expect(ruleBody(selector), selector).not.toMatch(/(^|[\s;{])height:/m);
    }
    expect(css).not.toContain("--picker-height");
  });

  it("lets the families wrap rather than scroll or squeeze on a phone", () => {
    expect(ruleBody(".families")).toContain("flex-wrap: wrap");
    expect(ruleBody(".source")).toContain("flex-wrap: wrap");
  });
});
