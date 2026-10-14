import {
  SELECTABLE_SERIES_GROUP_LABELS,
  type StrategyMetric,
  type StrategyValue,
} from "@intrinsic/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OperandPicker, type OperandPickerCategory } from "./OperandPicker";
import { ValueControl } from "./ValueControl";
import {
  activeCategory,
  categoryLabels,
  optionLabels,
  showCategory,
} from "./__testing__/operand-picker";

const CATEGORIES: readonly OperandPickerCategory[] = [
  {
    id: "A",
    label: "Alpha",
    options: [
      { key: "a1", label: "Alpha one" },
      { key: "a2", label: "Alpha two" },
    ],
  },
  {
    id: "B",
    label: "Beta",
    options: [
      { key: "b1", label: "Beta one" },
      { key: "b2", label: "Beta two" },
      { key: "b3", label: "Beta three" },
    ],
  },
  { id: "C", label: "Gamma", options: [{ key: "c1", label: "Gamma one" }] },
];

function labelOf(key: string): string {
  return (
    CATEGORIES.flatMap((category) => category.options).find(
      (option) => option.key === key,
    )?.label ?? key
  );
}

/** A picker holding its own choice, as a rule row holds its metric. */
function Harness({
  initial = "b2",
  onSelect = () => {},
}: {
  readonly initial?: string;
  readonly onSelect?: (key: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <div>
      <button type="button">Before</button>
      <OperandPicker
        label="Metric"
        testId="metric-picker"
        categories={CATEGORIES}
        selectedKey={selected}
        display={labelOf(selected)}
        invalid={false}
        onSelect={(key) => {
          onSelect(key);
          setSelected(key);
        }}
      />
      <button type="button">After</button>
    </div>
  );
}

const trigger = () => screen.getByTestId("metric-picker");
const panel = () => screen.queryByTestId("metric-picker-panel");

function pressed(container: HTMLElement, testId: string): string[] {
  return within(container)
    .getAllByTestId(testId)
    .filter((element) => element.getAttribute("aria-pressed") === "true")
    .map((element) => element.getAttribute("data-value") ?? "");
}

describe("OperandPicker", () => {
  it("reads as one control that names what it holds, and opens on demand", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(trigger().textContent).toBe("Beta two");
    expect(trigger().getAttribute("aria-label")).toBe("Metric: Beta two");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(trigger().getAttribute("aria-controls")).toBe(panel()?.id);
  });

  it("shows every category at once, opening on the current choice's category with it marked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    const open = panel()!;
    expect(categoryLabels(open)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(activeCategory(open)).toBe("B");
    expect(optionLabels(open)).toEqual(["Beta one", "Beta two", "Beta three"]);
    expect(pressed(open, "metric-picker-option")).toEqual(["b2"]);
    // Focus lands on the current choice, so the keyboard starts where the rule is.
    expect(document.activeElement).toBe(
      within(open)
        .getAllByTestId("metric-picker-option")
        .find((option) => option.getAttribute("data-value") === "b2"),
    );
  });

  it("browses another category without changing anything", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(trigger());
    await showCategory(user, panel()!, "A");
    expect(activeCategory(panel()!)).toBe("A");
    expect(optionLabels(panel()!)).toEqual(["Alpha one", "Alpha two"]);
    expect(pressed(panel()!, "metric-picker-option")).toEqual([]);
    // The category holding the current choice stays marked while another is browsed.
    expect(
      within(panel()!)
        .getAllByTestId("metric-picker-category")
        .filter((tile) => tile.getAttribute("data-current") === "true")
        .map((tile) => tile.getAttribute("data-value")),
    ).toEqual(["B"]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Beta two");
  });

  it("chooses an option, closes, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(trigger());
    await showCategory(user, panel()!, "C");
    await user.click(within(panel()!).getByText("Gamma one"));
    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(panel()).toBeNull();
    expect(trigger().textContent).toBe("Gamma one");
    expect(document.activeElement).toBe(trigger());
  });

  it("reopens on the chosen metric's category, not where the last browse was left", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await showCategory(user, panel()!, "C");
    await user.keyboard("{Escape}");
    await user.click(trigger());
    expect(activeCategory(panel()!)).toBe("B");
    expect(pressed(panel()!, "metric-picker-option")).toEqual(["b2"]);

    await showCategory(user, panel()!, "A");
    await user.click(within(panel()!).getByText("Alpha two"));
    await user.click(trigger());
    expect(activeCategory(panel()!)).toBe("A");
    expect(pressed(panel()!, "metric-picker-option")).toEqual(["a2"]);
  });

  it("does not report the current choice chosen again", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(trigger());
    await user.click(within(panel()!).getByText("Beta two"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a press outside it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole("button", { name: "After" }));
    expect(panel()).toBeNull();
  });

  it("closes when focus leaves it, but not when focus moves inside it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(
      within(panel()!).getAllByTestId("metric-picker-category")[0]!,
    );
    expect(panel()).not.toBeNull();
    act(() => {
      screen.getByRole("button", { name: "After" }).focus();
    });
    expect(panel()).toBeNull();
  });

  it("opens from the keyboard with an arrow key, like a select", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    act(() => trigger().focus());
    await user.keyboard("{ArrowDown}");
    expect(panel()).not.toBeNull();
  });

  it("closes from the close button and the scrim a phone shows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole("button", { name: "Close metric" }));
    expect(panel()).toBeNull();
    await user.click(trigger());
    fireEvent.click(screen.getByTestId("metric-picker-scrim"));
    expect(panel()).toBeNull();
  });

  it("reports a press's focus with its click, so nothing moves between press and release", () => {
    // On a phone the explanation is drawn under the focused row: reporting focus on the way down
    // would shift the row under the pointer and the browser would drop the click.
    const onFocus = vi.fn();
    render(
      <OperandPicker
        label="Metric"
        testId="metric-picker"
        categories={CATEGORIES}
        selectedKey="a1"
        display="Alpha one"
        invalid={false}
        onSelect={() => {}}
        onFocus={onFocus}
      />,
    );
    fireEvent.pointerDown(trigger());
    fireEvent.focus(trigger());
    expect(onFocus).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(panel()).not.toBeNull();

    // Focus that arrives from the keyboard is reported at once.
    fireEvent.click(trigger());
    fireEvent.blur(trigger());
    onFocus.mockClear();
    fireEvent.focus(trigger());
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("reads a prompt as a prompt", () => {
    render(
      <OperandPicker
        label="Value"
        testId="value-control"
        categories={CATEGORIES}
        selectedKey=""
        display="Choose"
        placeholder
        invalid
        onSelect={() => {}}
      />,
    );
    const button = screen.getByTestId("value-control");
    expect(button.getAttribute("data-placeholder")).toBe("true");
    expect(button.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the Value picker", () => {
  function renderValue(metric: StrategyMetric, value: StrategyValue) {
    const onChange = vi.fn();
    render(
      <ValueControl
        metric={metric}
        value={value}
        label="Value"
        invalid={false}
        onChange={onChange}
        onBlur={() => {}}
      />,
    );
    return onChange;
  }

  it("groups the series Price may be compared with as the catalog groups them", async () => {
    const user = userEvent.setup();
    renderValue({ kind: "PRICE" }, { kind: "SERIES", seriesId: "EMA_200D" });
    const button = screen.getByTestId("value-control");
    expect(button.textContent).toBe("EMA 200D");
    await user.click(button);
    const open = screen.getByTestId("value-control-panel");
    expect(categoryLabels(open)).toEqual([
      SELECTABLE_SERIES_GROUP_LABELS.MOVING_AVERAGES_DAILY,
      SELECTABLE_SERIES_GROUP_LABELS.MOVING_AVERAGES_WEEKLY,
      SELECTABLE_SERIES_GROUP_LABELS.INTRINSIC_VALUE_BLENDS,
      SELECTABLE_SERIES_GROUP_LABELS.INTRINSIC_VALUE_MODELS,
    ]);
    // An oscillator is never price-comparable, so it is no category here at all.
    expect(categoryLabels(open)).not.toContain(
      SELECTABLE_SERIES_GROUP_LABELS.OSCILLATORS,
    );
    expect(activeCategory(open)).toBe("MOVING_AVERAGES_DAILY");
    expect(pressed(open, "value-control-option")).toEqual(["EMA_200D"]);
  });

  it("offers a moving average only its same-timeframe comparisons, and hands back a series Value", async () => {
    const user = userEvent.setup();
    const onChange = renderValue(
      { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
      { kind: "SERIES", seriesId: "SMA_200D" },
    );
    await user.click(screen.getByTestId("value-control"));
    const open = screen.getByTestId("value-control-panel");
    expect(categoryLabels(open)).toEqual([
      SELECTABLE_SERIES_GROUP_LABELS.MOVING_AVERAGES_DAILY,
    ]);
    expect(optionLabels(open)).not.toContain("SMA 50D");
    await user.click(within(open).getByText("EMA 200D"));
    expect(onChange).toHaveBeenCalledWith({
      kind: "SERIES",
      seriesId: "EMA_200D",
    });
  });

  it("keeps a number a number: a threshold is typed, never picked", () => {
    renderValue(
      { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      { kind: "NUMBER", value: 30 },
    );
    const input = screen.getByTestId("value-control") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("30");
  });
});

/**
 * The responsive rules, asserted as declarations: jsdom has no layout, and each rule is decided by a
 * single declaration (`ai/architecture/strategy-builder.md` § 8–9). The trigger and the panel are the
 * shell's stylesheet; the tiles and the options are this picker's.
 */
describe("the picker's layout", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shell = readFileSync(join(here, "PickerPopover.module.css"), "utf8");
  const body = readFileSync(join(here, "OperandPicker.module.css"), "utf8");
  function ruleBody(css: string, selector: string, after = 0): string {
    const start = css.indexOf(`${selector} {`, after);
    expect(start, `${selector} is declared`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  }

  it("is a bottom sheet on a phone and an anchored popover from 600px", () => {
    expect(ruleBody(shell, ".panel")).toContain("position: fixed");
    const wide = shell.indexOf("@media (min-width: 600px)");
    expect(wide).toBeGreaterThan(-1);
    expect(ruleBody(shell, ".panel", wide)).toContain("position: absolute");
  });

  it("holds a tile picker's height above its trigger, and never a content-sized one's", () => {
    const wide = shell.indexOf("@media (min-width: 600px)");
    // Above the trigger a held panel keeps the height its longest category needs…
    expect(ruleBody(shell, '.panel[data-placement="above"]', wide)).toContain(
      "height: var(--picker-height, auto)",
    );
    // …while a content-sized one is only ever capped, to the room its side of the viewport has.
    const content = ruleBody(shell, '.panel[data-sizing="content"]', wide);
    expect(content).toContain("var(--picker-max-height, 100vh)");
    expect(content).not.toMatch(/(^|[^-])height:/);
  });

  it("lays the categories four to a row where there is room, and never scrolls them", () => {
    expect(ruleBody(shell, ".panel")).toContain(
      "container: picker-panel / inline-size",
    );
    const wide = body.indexOf("@container picker-panel (min-width: 440px)");
    expect(wide).toBeGreaterThan(-1);
    expect(ruleBody(body, ".categories", wide)).toContain(
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
    );
    expect(ruleBody(body, ".categories")).toContain("flex: none");
    expect(ruleBody(body, ".categories")).not.toContain("overflow");
  });

  it("lists the options two to a row, and scrolls only them", () => {
    expect(ruleBody(body, ".optionGrid")).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(ruleBody(body, ".options")).toContain("overflow-y: auto");
    expect(ruleBody(body, ".options")).toContain("min-height: 0");
  });
});
