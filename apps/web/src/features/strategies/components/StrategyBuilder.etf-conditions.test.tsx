import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStrategy,
  replaceStrategyDefinition,
} from "../api/strategies-api";
import { StrategyBuilder } from "./StrategyBuilder";
import {
  activeCategory,
  activeFamily,
  categoryLabels,
  chooseEtf,
  chooseEtfMetric,
  chooseMetric,
  chooseSectorMetric,
  chooseSeriesValue,
  chooseSource,
  etfSelect,
  familyLabels,
  openPicker,
  optionLabels,
  pickerText,
  pickerValue,
  shownSource,
} from "./__testing__/operand-picker";

/**
 * ETF-sourced Conditions in the Strategy Builder (`docs/decisions/strategy-etf-conditions-v1.md`).
 *
 * The Builder holds no ETF list, no ETF metric list and no rule about what an ETF may be compared
 * with: the twenty funds, their 21 metrics, the Values, the sentence and the explanation all come
 * from `@intrinsic/contracts`. These cases prove the three-control row renders what the registry
 * says, that each rule owns its own source, and that what is saved is what is shown.
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
    id: "s-etf",
    name: "Market context",
    buyLevelCount: definition.buyLevels.length,
    sellLevelCount: definition.sellLevels.length,
    hasFinalExit: definition.finalExit !== undefined,
    versionNumber: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    definition,
  };
}

/** The text of a select's chosen option: what the user sees in the control. */
function shown(select: HTMLElement): string | null {
  const element = select as HTMLSelectElement;
  return element.options[element.selectedIndex]?.textContent ?? null;
}

/** Each rule of the Strategy logic as its sentence alone: no connector, no trigger tag. */
function previewTexts(): string[] {
  return within(screen.getByTestId("logic-preview"))
    .getAllByTestId("preview-rule")
    .map((line) =>
      [...line.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim(),
    );
}

function rowsOf(card: string): HTMLElement[] {
  return within(screen.getByTestId(card)).getAllByTestId("predicate-row");
}

describe("an ETF condition beside stock conditions", () => {
  it("authors the decision's own example: four independent sources in one BUY signal", async () => {
    const user = userEvent.setup();
    createStrategyMock.mockResolvedValue(
      strategyWith({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [],
        sellLevels: [],
      }),
    );
    render(<StrategyBuilder />);
    await user.type(screen.getByLabelText("Name"), "Market context");
    await user.click(screen.getByTestId("add-level-BUY"));
    for (let added = 0; added < 3; added += 1) {
      await user.click(screen.getByTestId("add-condition"));
    }
    const [growth, xlk, spy, gld] = rowsOf("level-card-BUY");

    // Stock · Revenue Growth TTM YoY is above 15%
    await chooseMetric(
      user,
      growth!,
      "FUNDAMENTALS",
      "FUNDAMENTAL:REVENUE_GROWTH_TTM_YOY",
    );
    const growthValue = within(growth!).getByTestId("value-control");
    await user.clear(growthValue);
    await user.type(growthValue, "15");

    // XLK · RSI 14D is above 50
    await chooseEtfMetric(
      user,
      xlk!,
      "ETF_XLK",
      "OSCILLATORS",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );

    // SPY · Price is above SMA 200D
    await chooseEtfMetric(user, spy!, "SP500", "PRICE", "ETF(SP500)|PRICE:");
    await chooseSeriesValue(user, spy!, "SMA_200D");

    // GLD · RVOL 20 is above 1.5x
    await chooseEtfMetric(
      user,
      gld!,
      "ETF_GLD",
      "VOLUME",
      "ETF(ETF_GLD)|RELATIVE_VOLUME:20",
    );
    const gldValue = within(gld!).getByTestId("value-control");
    await user.clear(gldValue);
    await user.type(gldValue, "1.5");

    // Each collapsed Metric control names its own source; the stock rule names none.
    expect([growth, xlk, spy, gld].map((row) => pickerText(row!))).toEqual([
      "Revenue Growth TTM YoY",
      "XLK · RSI 14D",
      "SPY · Price",
      "GLD · RVOL 20",
    ]);
    // …and so does the Strategy logic, in the one canonical sentence.
    expect(previewTexts()).toEqual([
      "Revenue Growth TTM YoY is above 15%",
      "XLK · RSI 14D is above 50",
      "SPY · Price is above SMA 200D",
      "GLD · RVOL 20 is above 1.5x",
    ]);

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(createStrategyMock).toHaveBeenCalledTimes(1));
    const saved =
      createStrategyMock.mock.calls[0]?.[0].definition.buyLevels[0]?.signal
        .conditions ?? [];
    // The stable benchmark code is what is stored — SPY is the SP500 series — never the ticker.
    expect(
      saved.map(({ metric, operator, value }) => ({ metric, operator, value })),
    ).toEqual([
      {
        metric: { kind: "FUNDAMENTAL", metricId: "REVENUE_GROWTH_TTM_YOY" },
        operator: "IS_ABOVE",
        value: { kind: "PERCENT", value: 15 },
      },
      {
        metric: {
          kind: "OSCILLATOR",
          seriesId: "RSI_14D",
          source: { kind: "ETF", code: "ETF_XLK" },
        },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      },
      {
        metric: { kind: "PRICE", source: { kind: "ETF", code: "SP500" } },
        operator: "IS_ABOVE",
        value: { kind: "SERIES", seriesId: "SMA_200D" },
      },
      {
        metric: {
          kind: "RELATIVE_VOLUME",
          period: 20,
          source: { kind: "ETF", code: "ETF_GLD" },
        },
        operator: "IS_ABOVE",
        value: { kind: "MULTIPLE", value: 1.5 },
      },
    ]);
  });

  it("keeps the three controls: no fourth, and the source lives in the Metric popover alone", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await chooseEtfMetric(
      user,
      row,
      "ETF_XLK",
      "OSCILLATORS",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );
    // Metric, Condition, Value — and the row's own remove button. Nothing else is a control.
    expect(within(row).getByTestId("metric-picker")).toBeDefined();
    expect(within(row).getByTestId("operator-select")).toBeDefined();
    expect(within(row).getByTestId("value-control")).toBeDefined();
    expect(within(row).queryByTestId("metric-picker-etf")).toBeNull();
    expect(within(row).queryByTestId("operand-config-button")).toBeNull();
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Metric: XLK · RSI 14D", "Remove condition 1"]);
  });

  it("moves one rule Stock -> SPY -> XLK -> Stock without touching the rule beside it", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));
    const [first, second] = rowsOf("level-card-BUY");
    await chooseMetric(user, first!, "OSCILLATORS", "OSCILLATOR:RSI_14D");
    await chooseMetric(user, second!, "OSCILLATORS", "OSCILLATOR:RSI_7D");
    const threshold = within(first!).getByTestId("value-control");
    await user.clear(threshold);
    await user.type(threshold, "35");
    await user.selectOptions(
      within(first!).getByTestId("operator-select"),
      "IS_BELOW",
    );
    const neighbour = () => [
      pickerValue(second!),
      shown(within(second!).getByTestId("operator-select")),
      (within(second!).getByTestId("value-control") as HTMLInputElement).value,
    ];
    const before = neighbour();

    const panel = await openPicker(user, first!);
    await chooseSource(user, panel, "ETF");
    expect(pickerText(first!)).toBe("SPY · RSI 14D");
    expect(neighbour()).toEqual(before);

    await chooseEtf(user, panel, "ETF_XLK");
    expect(pickerText(first!)).toBe("XLK · RSI 14D");
    expect(pickerValue(first!)).toBe("ETF(ETF_XLK)|OSCILLATOR:RSI_14D");
    expect(neighbour()).toEqual(before);

    await chooseSource(user, panel, "STOCK");
    expect(pickerText(first!)).toBe("RSI 14D");
    expect(pickerValue(first!)).toBe("OSCILLATOR:RSI_14D");
    expect(neighbour()).toEqual(before);

    // The threshold and the comparison came through every move, and nothing was announced as reset.
    expect(shown(within(first!).getByTestId("operator-select"))).toBe("is below");
    expect(
      (within(first!).getByTestId("value-control") as HTMLInputElement).value,
    ).toBe("35");
    expect(within(first!).queryByTestId("row-change-notice")).toBeNull();
    expect(previewTexts()).toEqual([
      "RSI 14D is below 35",
      "RSI 7D is above 50",
    ]);
  });

  it("offers ETF Price the ETF's own moving averages, and no intrinsic value", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");

    // On the stock, Price may be compared with the intrinsic-value series too.
    let values = await openPicker(user, row, "value-control");
    expect(categoryLabels(values)).toContain("Intrinsic Value — Blends");
    await user.keyboard("{Escape}");

    await chooseEtfMetric(user, row, "ETF_XLK", "PRICE", "ETF(ETF_XLK)|PRICE:");
    values = await openPicker(user, row, "value-control");
    expect(categoryLabels(values)).toEqual([
      "Moving averages — Daily",
      "Moving averages — Weekly",
    ]);
    expect(optionLabels(values)).toHaveLength(7);
  });

  it("says so when a change of source cannot keep the rule's Value", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await user.selectOptions(
      within(row).getByTestId("operator-select"),
      "IS_BELOW",
    );
    await chooseSeriesValue(user, row, "BALANCED");
    expect(previewTexts()).toEqual(["Price is below Balanced"]);

    const panel = await openPicker(user, row);
    await chooseSource(user, panel, "ETF");
    // An intrinsic value is not something an ETF's Price can be compared with: the rule is reset
    // to the ETF metric's own starting rule, never left invalid — and it says exactly that, inside
    // the open popover and under the row.
    const sentence = "Condition and value were reset to match SPY · Price.";
    expect(within(panel).getByTestId("metric-picker-hint").textContent).toBe(
      sentence,
    );
    const notice = within(row).getByTestId("row-change-notice");
    expect(notice.textContent).toBe(sentence);
    expect(notice.getAttribute("role")).toBe("status");
    expect(shown(within(row).getByTestId("operator-select"))).toBe("is above");
    expect(pickerText(row, "value-control")).toBe("SMA 20D");
    expect(previewTexts()).toEqual(["SPY · Price is above SMA 20D"]);
    expect(within(row).queryByRole("alert")).toBeNull();

    // Moving on to another fund replaces nothing more — and retracts nothing: the Value the user
    // wrote is still gone, so the line stays and names the rule as it now reads.
    await chooseEtf(user, panel, "ETF_GLD");
    const onGld = "Condition and value were reset to match GLD · Price.";
    expect(within(panel).getByTestId("metric-picker-hint").textContent).toBe(
      onGld,
    );
    expect(within(row).getByTestId("row-change-notice").textContent).toBe(
      onGld,
    );
    expect(previewTexts()).toEqual(["GLD · Price is above SMA 20D"]);

    // The line is cleared by the next edit of the rule itself: it reports a reset, not the rule.
    await user.keyboard("{Escape}");
    await chooseSeriesValue(user, row, "SMA_200D");
    expect(within(row).queryByTestId("row-change-notice")).toBeNull();
  });

  it("announces a stock change of metric that replaces the Value the same way", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await chooseMetric(user, row, "OSCILLATORS", "OSCILLATOR:RSI_14D");
    expect(within(row).getByTestId("row-change-notice").textContent).toBe(
      "Value was reset to match RSI 14D.",
    );
    // Until the rule is edited the line follows it: another period replaced nothing more, and the
    // threshold on show is still the default rather than one the user wrote.
    await chooseMetric(user, row, "OSCILLATORS", "OSCILLATOR:RSI_7D");
    expect(within(row).getByTestId("row-change-notice").textContent).toBe(
      "Value was reset to match RSI 7D.",
    );
    // A threshold of the user's own ends it, and a change that keeps that threshold says nothing.
    const threshold = within(row).getByTestId("value-control");
    await user.clear(threshold);
    await user.type(threshold, "35");
    expect(within(row).queryByTestId("row-change-notice")).toBeNull();
    await chooseMetric(user, row, "OSCILLATORS", "OSCILLATOR:RSI_21D");
    expect(within(row).queryByTestId("row-change-notice")).toBeNull();
    expect(previewTexts()).toEqual(["RSI 21D is above 35"]);
  });

  it("refuses the same ETF rule twice, and accepts the same rule on another ETF", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));
    const [first, second] = rowsOf("level-card-BUY");
    await chooseEtfMetric(
      user,
      first!,
      "ETF_XLK",
      "OSCILLATORS",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );
    await chooseEtfMetric(
      user,
      second!,
      "ETF_XLF",
      "OSCILLATORS",
      "ETF(ETF_XLF)|OSCILLATOR:RSI_14D",
    );
    // Same metric, same threshold, different funds: two conditions, and no complaint.
    expect(within(second!).queryByRole("alert")).toBeNull();

    const panel = await openPicker(user, second!);
    await chooseEtf(user, panel, "ETF_XLK");
    await user.keyboard("{Escape}");
    expect(within(second!).getByRole("alert").textContent).toContain(
      "repeats condition 1",
    );
  });
});

describe("ETF conditions in SELL and FINAL EXIT", () => {
  it("authors an independent ETF condition in each level kind, beside the position metrics", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-SELL"));
    await user.click(screen.getByTestId("add-level-FINAL_EXIT"));

    const [sell] = rowsOf("level-card-SELL");
    // The stock keeps Position in a SELL level…
    let panel = await openPicker(user, sell!);
    expect(familyLabels(panel)).toContain("Position");
    // …and an ETF offers Technical alone there too.
    await chooseSource(user, panel, "ETF");
    expect(familyLabels(panel)).toEqual(["Technical"]);
    await user.keyboard("{Escape}");
    await chooseEtfMetric(
      user,
      sell!,
      "ETF_TLT",
      "MOVING_AVERAGES",
      "ETF(ETF_TLT)|MOVING_AVERAGE:SMA_50D",
    );
    await user.click(
      within(screen.getByTestId("level-card-SELL")).getByTestId("add-condition"),
    );
    const sellGain = rowsOf("level-card-SELL")[1]!;
    await chooseMetric(user, sellGain, "POSITION", "GAIN:");

    const [exit] = rowsOf("level-card-FINAL_EXIT");
    await chooseEtfMetric(
      user,
      exit!,
      "ETF_HYG",
      "OSCILLATORS",
      "ETF(ETF_HYG)|OSCILLATOR:RSI_21D",
    );
    panel = await openPicker(user, exit!);
    expect(shownSource(panel)).toBe("ETF");
    expect(etfSelect(panel)!.value).toBe("ETF_HYG");
    await user.keyboard("{Escape}");

    expect(previewTexts()).toEqual([
      "Price is above SMA 20D",
      "TLT · SMA 50D is above SMA 20D",
      "Gain is above 0%",
      "HYG · RSI 21D is above 50",
    ]);
  });

  it("offers a Trigger row no ETF, while its Condition rows keep theirs", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-trigger"));
    const rows = screen.getAllByTestId("predicate-row");
    const triggerPanel = await openPicker(user, rows.at(-1)!);
    const etf = within(triggerPanel)
      .getAllByTestId("metric-picker-source")
      .find((radio) => radio.getAttribute("data-value") === "ETF") as HTMLInputElement;
    expect(etf.disabled).toBe(true);
    expect(within(triggerPanel).getByTestId("metric-picker-hint").textContent).toBe(
      "An ETF or the stock's sector can be read by a condition only, not by a trigger.",
    );
    await user.keyboard("{Escape}");

    const conditionPanel = await openPicker(user, rows[0]!);
    expect(
      (
        within(conditionPanel)
          .getAllByTestId("metric-picker-source")
          .find(
            (radio) => radio.getAttribute("data-value") === "ETF",
          ) as HTMLInputElement
      ).disabled,
    ).toBe(false);
  });
});

describe("a saved ETF strategy in the Builder", () => {
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
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_BELOW",
              value: { kind: "NUMBER", value: 40 },
            },
            {
              id: "c2",
              metric: {
                kind: "MOVING_AVERAGE",
                seriesId: "SMA_50W",
                source: { kind: "ETF", code: "ETF_XLRE" },
              },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_200W" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  });

  it("reads back exactly as it was saved: source, fund, family, subgroup and metric", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={SAVED} />);
    const [stock, etf] = screen.getAllByTestId("predicate-row");
    expect(pickerText(stock!)).toBe("RSI 14D");
    expect(pickerText(etf!)).toBe("XLRE · SMA 50W");
    expect(pickerText(etf!, "value-control")).toBe("SMA 200W");
    expect(previewTexts()).toEqual([
      "RSI 14D is below 40",
      "XLRE · SMA 50W is above SMA 200W",
    ]);

    const panel = await openPicker(user, etf!);
    expect(shownSource(panel)).toBe("ETF");
    expect(etfSelect(panel)!.value).toBe("ETF_XLRE");
    expect(shown(etfSelect(panel)!)).toBe("XLRE — Real Estate");
    expect(activeFamily(panel)).toBe("TECHNICAL");
    expect(activeCategory(panel)).toBe("MOVING_AVERAGES");
    expect(
      within(panel)
        .getAllByTestId("metric-picker-option")
        .filter((option) => option.getAttribute("aria-pressed") === "true")
        .map((option) => option.textContent),
    ).toEqual(["SMA 50W"]);
    await user.keyboard("{Escape}");

    // The stock rule beside it opens on the stock, with no fund on show.
    const stockPanel = await openPicker(user, stock!);
    expect(shownSource(stockPanel)).toBe("STOCK");
    expect(etfSelect(stockPanel)).toBeNull();
  });

  it("is unchanged by being opened: nothing is rewritten until the user edits", () => {
    render(<StrategyBuilder strategy={SAVED} />);
    expect(screen.getByTestId("save-strategy")).toHaveProperty("disabled", true);
  });

  it("explains an ETF metric as read from the fund, at the end of its day", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={SAVED} />);
    const etf = screen.getAllByTestId("predicate-row")[1]!;
    await user.click(within(etf).getByTestId("metric-picker"));
    await user.keyboard("{Escape}");
    const explanation = screen.getByTestId("explanation-panel");
    expect(within(explanation).getByText("XLRE · SMA 50W")).toBeDefined();
    expect(explanation.textContent).toContain(
      "Read from XLRE (Real Estate) rather than the evaluated stock",
    );
    expect(explanation.textContent).toContain("end-of-day bar is final");
  });
});

describe("a Stock's Sector condition in the Builder", () => {
  const replaceDefinitionMock = vi.mocked(replaceStrategyDefinition);

  it("authors Stock, ETF and Stock's Sector rules side by side and saves the source with no fund", async () => {
    const user = userEvent.setup();
    createStrategyMock.mockResolvedValue(
      strategyWith({
        schemaVersion: STRATEGY_SCHEMA_VERSION,
        buyLevels: [],
        sellLevels: [],
      }),
    );
    render(<StrategyBuilder />);
    await user.type(screen.getByLabelText("Name"), "Sector context");
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));
    await user.click(screen.getByTestId("add-condition"));
    const [stock, xlk, sector] = rowsOf("level-card-BUY");

    await chooseMetric(user, stock!, "OSCILLATORS", "OSCILLATOR:RSI_14D");
    await chooseEtfMetric(
      user,
      xlk!,
      "ETF_XLK",
      "OSCILLATORS",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );
    await chooseSectorMetric(user, sector!, "OSCILLATORS", "STOCK_SECTOR|OSCILLATOR:RSI_14D");

    // Three sources of the same metric: three conditions, none a duplicate of another.
    expect([stock, xlk, sector].map((row) => pickerText(row!))).toEqual([
      "RSI 14D",
      "XLK · RSI 14D",
      "Stock's Sector · RSI 14D",
    ]);
    for (const row of [stock, xlk, sector]) {
      expect(within(row!).queryByRole("alert")).toBeNull();
    }
    expect(previewTexts()).toEqual([
      "RSI 14D is above 50",
      "XLK · RSI 14D is above 50",
      "Stock's Sector · RSI 14D is above 50",
    ]);
    // Still the three controls.
    expect(
      within(sector!)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Metric: Stock's Sector · RSI 14D", "Remove condition 3"]);

    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(createStrategyMock).toHaveBeenCalledTimes(1));
    const saved =
      createStrategyMock.mock.calls[0]?.[0].definition.buyLevels[0]?.signal
        .conditions ?? [];
    expect(saved.map(({ metric }) => metric)).toEqual([
      { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      {
        kind: "OSCILLATOR",
        seriesId: "RSI_14D",
        source: { kind: "ETF", code: "ETF_XLK" },
      },
      // No code, no ticker, no sector name: the evaluated stock decides.
      { kind: "OSCILLATOR", seriesId: "RSI_14D", source: { kind: "STOCK_SECTOR" } },
    ]);
  });

  it("says so when a move to Stock's Sector cannot keep the rule's Value", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    const row = screen.getByTestId("predicate-row");
    await user.selectOptions(within(row).getByTestId("operator-select"), "IS_BELOW");
    await chooseSeriesValue(user, row, "BALANCED");

    const panel = await openPicker(user, row);
    await chooseSource(user, panel, "STOCK_SECTOR");
    const sentence = "Condition and value were reset to match Stock's Sector · Price.";
    expect(within(panel).getByTestId("metric-picker-hint").textContent).toBe(sentence);
    expect(within(row).getByTestId("row-change-notice").textContent).toBe(sentence);
    expect(pickerText(row, "value-control")).toBe("SMA 20D");
    expect(previewTexts()).toEqual(["Stock's Sector · Price is above SMA 20D"]);

    // Its Value is the sector fund's own moving averages, and no intrinsic value.
    await user.keyboard("{Escape}");
    const values = await openPicker(user, row, "value-control");
    expect(categoryLabels(values)).toEqual([
      "Moving averages — Daily",
      "Moving averages — Weekly",
    ]);
  });

  it("refuses the same Stock's Sector rule twice", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-condition"));
    const [first, second] = rowsOf("level-card-BUY");
    await chooseSectorMetric(user, first!, "OSCILLATORS", "STOCK_SECTOR|OSCILLATOR:RSI_14D");
    await chooseSectorMetric(user, second!, "OSCILLATORS", "STOCK_SECTOR|OSCILLATOR:RSI_14D");
    expect(within(second!).getByRole("alert").textContent).toContain(
      "repeats condition 1",
    );
  });

  it("authors a Stock's Sector rule in SELL and FINAL EXIT too, and offers it no Trigger", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder />);
    await user.click(screen.getByTestId("add-level-BUY"));
    await user.click(screen.getByTestId("add-level-SELL"));
    await user.click(screen.getByTestId("add-level-FINAL_EXIT"));
    const sell = rowsOf("level-card-SELL")[0]!;
    await chooseSectorMetric(user, sell, "PRICE", "STOCK_SECTOR|PRICE:");
    expect(pickerText(sell)).toBe("Stock's Sector · Price");
    const exit = rowsOf("level-card-FINAL_EXIT")[0]!;
    await chooseSectorMetric(user, exit, "VOLUME", "STOCK_SECTOR|RELATIVE_VOLUME:20");
    expect(pickerText(exit)).toBe("Stock's Sector · RVOL 20");
    expect(previewTexts()).toContain("Stock's Sector · Price is above SMA 20D");
    expect(previewTexts()).toContain("Stock's Sector · RVOL 20 is above 1.0x");
  });

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
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_BELOW",
              value: { kind: "NUMBER", value: 40 },
            },
            {
              id: "c2",
              metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  });

  it("reads a saved Stock's Sector rule back as it was saved, unchanged until edited", async () => {
    const user = userEvent.setup();
    render(<StrategyBuilder strategy={SAVED} />);
    expect(screen.getByTestId("save-strategy")).toHaveProperty("disabled", true);
    const [, sector] = screen.getAllByTestId("predicate-row");
    expect(pickerText(sector!)).toBe("Stock's Sector · Price");
    expect(pickerText(sector!, "value-control")).toBe("SMA 200D");
    expect(previewTexts()).toEqual([
      "RSI 14D is below 40",
      "Stock's Sector · Price is above SMA 200D",
    ]);
    const panel = await openPicker(user, sector!);
    expect(shownSource(panel)).toBe("STOCK_SECTOR");
    expect(etfSelect(panel)).toBeNull();
    expect(activeCategory(panel)).toBe("PRICE");
    await user.keyboard("{Escape}");

    const explanation = screen.getByTestId("explanation-panel");
    expect(explanation.textContent).toContain("Technology reads XLK");
    expect(explanation.textContent).toContain("current");
  });

  it("keeps the source through an edit of the rule's Value, saved as a new version", async () => {
    const user = userEvent.setup();
    replaceDefinitionMock.mockResolvedValue(SAVED);
    render(<StrategyBuilder strategy={SAVED} />);
    const [, sector] = screen.getAllByTestId("predicate-row");
    await chooseSeriesValue(user, sector!, "SMA_50D");
    await user.click(screen.getByTestId("save-strategy"));
    await waitFor(() => expect(replaceDefinitionMock).toHaveBeenCalledTimes(1));
    const definition = replaceDefinitionMock.mock.calls[0]?.[1];
    expect(definition?.buyLevels[0]?.signal.conditions[1]).toMatchObject({
      metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: "SMA_50D" },
    });
  });
});
