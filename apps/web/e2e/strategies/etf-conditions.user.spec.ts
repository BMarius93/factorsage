import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyCondition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseFromOverflowMenu } from "../utils/overflow-menu";
import {
  categoryLabels,
  chooseEtf,
  chooseEtfMetric,
  chooseMetric,
  chooseSectorMetric,
  chooseSeriesValue,
  chooseSource,
  familyLabels,
  openPicker,
  optionLabels,
  showCategory,
  showFamily,
  sourceChoice,
} from "../utils/strategy-builder";

/**
 * ETF-sourced Conditions in the Strategy Builder, for PRO_USER
 * (`docs/decisions/strategy-etf-conditions-v1.md`).
 *
 * What only a browser against the real API can prove: that the Metric popover really is compact and
 * usable with a pointer, a keyboard and a thumb; that a rule reading an ETF says so on every surface;
 * and that what is saved, reloaded, edited and duplicated is the rule the user built — its source
 * stored as the stable benchmark code, never the ticker.
 *
 * The universe below is written out from the decision, not read from the registry, so the picker is
 * held to the product's accepted list rather than to whatever the code happens to hold.
 *
 * Needs no securities and no market data: a strategy references only the static catalogs.
 */

const ETF_GROUPS = [
  {
    label: "Benchmarks",
    funds: [
      { code: "SP500", ticker: "SPY", market: "S&P 500" },
      { code: "ETF_QQQ", ticker: "QQQ", market: "Nasdaq-100" },
      { code: "ETF_DIA", ticker: "DIA", market: "Dow Jones" },
      { code: "ETF_IWM", ticker: "IWM", market: "Russell 2000" },
      { code: "ETF_RSP", ticker: "RSP", market: "S&P 500 Equal Weight" },
    ],
  },
  {
    label: "Sectors",
    funds: [
      { code: "ETF_XLK", ticker: "XLK", market: "Technology" },
      { code: "ETF_XLF", ticker: "XLF", market: "Financials" },
      { code: "ETF_XLE", ticker: "XLE", market: "Energy" },
      { code: "ETF_XLV", ticker: "XLV", market: "Healthcare" },
      { code: "ETF_XLI", ticker: "XLI", market: "Industrials" },
      { code: "ETF_XLY", ticker: "XLY", market: "Consumer Discretionary" },
      { code: "ETF_XLP", ticker: "XLP", market: "Consumer Staples" },
      { code: "ETF_XLU", ticker: "XLU", market: "Utilities" },
      { code: "ETF_XLB", ticker: "XLB", market: "Materials" },
      { code: "ETF_XLRE", ticker: "XLRE", market: "Real Estate" },
      { code: "ETF_XLC", ticker: "XLC", market: "Communication Services" },
    ],
  },
  {
    label: "Macro & Alternatives",
    funds: [
      { code: "ETF_GLD", ticker: "GLD", market: "Gold" },
      { code: "ETF_USO", ticker: "USO", market: "Oil Futures" },
      { code: "ETF_TLT", ticker: "TLT", market: "Long-Term Treasuries" },
      { code: "ETF_HYG", ticker: "HYG", market: "High-Yield Bonds" },
    ],
  },
] as const;

const ALL_FUNDS = ETF_GROUPS.flatMap((group) => [...group.funds]);

/** The 21 metrics an ETF offers, by subgroup, as the decision lists them. */
const ETF_METRICS = {
  PRICE: ["Price"],
  MOVING_AVERAGES: [
    "SMA 20D",
    "SMA 50D",
    "SMA 100D",
    "SMA 200D",
    "EMA 20D",
    "EMA 50D",
    "EMA 200D",
    "SMA 20W",
    "SMA 50W",
    "SMA 100W",
    "SMA 200W",
    "EMA 20W",
    "EMA 50W",
    "EMA 200W",
  ],
  OSCILLATORS: ["RSI 7D", "RSI 14D", "RSI 21D"],
  VOLUME: ["RVOL 10", "RVOL 20", "RVOL 50"],
} as const;

function strategyIdOf(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

async function readStrategy(
  page: Page,
  strategyId: string,
): Promise<StrategyDetailResponse> {
  const response = await page.request.get(
    `${apiBaseUrl()}/strategies/${strategyId}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as StrategyDetailResponse;
}

/** Best-effort teardown, so a failure cannot leave PRO_USER accumulating strategies. */
async function deleteStrategies(page: Page, ids: readonly (string | null)[]) {
  for (const id of ids) {
    if (id) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${id}`)
        .catch(() => {});
    }
  }
}

function withoutIds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(withoutIds);
  }
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "id")
        .map(([key, value]) => [key, withoutIds(value)]),
    );
  }
  return node;
}

/** What a stored condition says, without its row id. */
function rule({ metric, operator, value }: StrategyCondition) {
  return { metric, operator, value };
}

function rows(page: Page, card: string): Locator {
  return page.getByTestId(card).first().getByTestId("predicate-row");
}

async function startStrategy(page: Page, name: string): Promise<Locator> {
  await page.goto("/strategies/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByTestId("add-level-BUY").click();
  return rows(page, "level-card-BUY").first();
}

/** Every rule of the Strategy logic as its sentence alone: no connector and no trigger tag. */
async function previewSentences(page: Page): Promise<string[]> {
  return page
    .getByTestId("logic-preview")
    .getByTestId("preview-rule")
    .evaluateAll((lines) =>
      lines.map((line) =>
        [...line.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join("")
          .trim(),
      ),
    );
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/**
 * An open Metric picker shows this rule's own source, fund, family, subgroup and metric — what
 * "editing displays the selected source, ETF, family and metric" means, in one place.
 */
async function expectPickerOnEtf(
  panel: Locator,
  expected: { code: string; category: string; metric: string },
): Promise<void> {
  await expect(sourceChoice(panel, "ETF")).toBeChecked();
  await expect(panel.getByTestId("metric-picker-etf")).toHaveValue(
    expected.code,
  );
  await expect(
    panel.locator('[data-testid="metric-picker-family"][aria-selected="true"]'),
  ).toHaveAttribute("data-value", "TECHNICAL");
  await expect(
    panel.locator(
      `[data-testid="metric-picker-category"][data-value="${expected.category}"]`,
    ),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    panel.locator('[data-testid="metric-picker-option"][aria-pressed="true"]'),
  ).toHaveText(expected.metric);
}

test.describe("ETF conditions in the Strategy Builder", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("offers the stock or one of twenty ETFs as a rule's data source, and an ETF only its 21 technical metrics", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E etf sources ${Date.now()}`);
    const panel = await openPicker(row);

    // A new rule reads the stock: no fund is asked for, and every stock family is on offer.
    await expect(sourceChoice(panel, "STOCK")).toBeChecked();
    await expect(sourceChoice(panel, "ETF")).toBeEnabled();
    await expect(panel.getByTestId("metric-picker-etf")).toHaveCount(0);
    expect(await familyLabels(panel)).toEqual([
      "Technical",
      "Fundamentals",
      "Valuation",
      "Activity",
    ]);

    // ETF: the twenty funds, in the decision's three groups, each by ticker and market.
    await chooseSource(panel, "ETF");
    const select = panel.getByTestId("metric-picker-etf");
    await expect(select).toBeVisible();
    await expect(select).toHaveAccessibleName("ETF");
    const groups = await select.locator("optgroup").evaluateAll((elements) =>
      elements.map((element) => ({
        label: element.getAttribute("label"),
        options: [...element.querySelectorAll("option")].map((option) => ({
          value: option.value,
          text: option.textContent,
        })),
      })),
    );
    expect(groups).toEqual(
      ETF_GROUPS.map((group) => ({
        label: group.label,
        options: group.funds.map((fund) => ({
          value: fund.code,
          text: `${fund.ticker} — ${fund.market}`,
        })),
      })),
    );
    expect(groups.flatMap((group) => group.options)).toHaveLength(20);

    // An ETF offers Technical alone, as four subgroups holding exactly the 21 compatible metrics.
    expect(await familyLabels(panel)).toEqual(["Technical"]);
    expect(await categoryLabels(panel)).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Volume",
    ]);
    const offered: string[] = [];
    for (const [category, metrics] of Object.entries(ETF_METRICS)) {
      await showCategory(panel, category);
      // One subgroup is open at a time, so the options on show are that subgroup's alone.
      await expect(
        panel.locator(
          '[data-testid="metric-picker-category"][aria-expanded="true"]',
        ),
      ).toHaveCount(1);
      expect(await optionLabels(panel)).toEqual([...metrics]);
      offered.push(...(await optionLabels(panel)));
    }
    expect(offered).toHaveLength(21);

    // Every one of the twenty can be read. The rule keeps its metric as the fund changes, and the
    // collapsed control, the Strategy logic and the stored identity all follow at once.
    const control = row.getByTestId("metric-picker");
    for (const fund of ALL_FUNDS) {
      await select.selectOption(fund.code);
      await expect(control).toHaveAttribute(
        "data-value",
        `ETF(${fund.code})|PRICE:`,
      );
      await expect(control).toHaveText(`${fund.ticker} · Price`);
    }
    expect(await previewSentences(page)).toEqual(["HYG · Price is above SMA 20D"]);

    // Back to the stock: the same metric, and no source left behind.
    await chooseSource(panel, "STOCK");
    await expect(control).toHaveAttribute("data-value", "PRICE:");
    await expect(control).toHaveText("Price");
    await expect(panel.getByTestId("metric-picker-etf")).toHaveCount(0);
    expect(await familyLabels(panel)).toHaveLength(4);
  });

  // A rule low on the screen opens its popover above itself, one with room beneath opens it below.
  // Either way the popover stays attached to the rule and is exactly as tall as what it shows.
  for (const { height, side } of [
    { height: 900, side: "above" },
    { height: 1300, side: "below" },
  ] as const) {
    test(`stays compact ${side} the rule: as tall as what it shows, scrolling only its list, never holding blank space`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height });
      const row = await startStrategy(page, `E2E etf compact ${Date.now()}`);
      const metric = (await row.getByTestId("metric-picker").boundingBox())!;
      const panel = await openPicker(row);
      await chooseEtf(panel, "ETF_XLK");
      await expect(panel).toHaveAttribute("data-placement", side);
      const library = panel.getByTestId("metric-picker-options");
      const options = panel.getByTestId("metric-picker-option");
      const headers = panel.getByTestId("metric-picker-category");
      const sources = panel.getByTestId("metric-picker-sources");
      const firstTab = panel.getByTestId("metric-picker-family").first();

      const measure = async () => {
        const box = (await panel.boundingBox())!;
        // On screen, and attached to the rule by the same small gap whatever it is showing: the edge
        // beside the Metric control never moves, so the popover never drifts away from its rule.
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        expect(box.x + box.width).toBeLessThanOrEqual(1440);
        const gap =
          side === "above"
            ? metric.y - (box.y + box.height)
            : box.y - (metric.y + metric.height);
        expect(gap).toBeGreaterThanOrEqual(4);
        expect(gap).toBeLessThanOrEqual(8);
        const lastHeader =
          (await headers.count()) > 0
            ? await headers.last().boundingBox()
            : null;
        const lastOption =
          (await options.count()) > 0
            ? await options.last().boundingBox()
            : null;
        const contentBottom = Math.max(
          lastHeader ? lastHeader.y + lastHeader.height : 0,
          lastOption ? lastOption.y + lastOption.height : 0,
        );
        return {
          height: box.height,
          // What the panel holds open beneath the last thing it shows.
          blank: box.y + box.height - contentBottom,
          scrollable: await library.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        };
      };

      // Price is one metric: one row under its header, in a popover well short of its cap.
      await showCategory(panel, "PRICE");
      await expect(options).toHaveCount(1);
      const price = await measure();
      expect(price.scrollable).toBeLessThanOrEqual(1);
      expect(price.blank).toBeLessThanOrEqual(24);
      expect(price.height).toBeLessThan(330);

      // Fourteen moving averages grow it — to its cap at most — and the surplus scrolls in the list.
      await showCategory(panel, "MOVING_AVERAGES");
      await expect(options).toHaveCount(14);
      const averages = await measure();
      expect(averages.height).toBeGreaterThan(price.height);
      expect(averages.height).toBeLessThanOrEqual(440);
      await expect(library).toHaveCSS("overflow-y", "auto");
      expect(averages.scrollable).toBeGreaterThan(0);
      // Scrolling the list moves the list alone: not the page, the source or the family tabs.
      const sourceTop = (await sources.boundingBox())!.y;
      const tabTop = (await firstTab.boundingBox())!.y;
      const pageScroll = await page.evaluate(() => window.scrollY);
      await library.evaluate((element) =>
        element.scrollTo(0, element.scrollHeight),
      );
      await expect(headers.last()).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
      expect((await sources.boundingBox())!.y).toBe(sourceTop);
      expect((await firstTab.boundingBox())!.y).toBe(tabTop);

      // Three oscillators: shorter again, with nothing left to scroll and nothing held open.
      await showCategory(panel, "OSCILLATORS");
      await expect(options).toHaveCount(3);
      const oscillators = await measure();
      expect(oscillators.height).toBeLessThan(averages.height);
      expect(oscillators.scrollable).toBeLessThanOrEqual(1);
      expect(oscillators.blank).toBeLessThanOrEqual(24);

      // Closing every subgroup leaves four lines, and the popover shrinks back to them.
      await panel
        .locator(
          '[data-testid="metric-picker-category"][data-value="OSCILLATORS"]',
        )
        .click();
      await expect(options).toHaveCount(0);
      const closed = await measure();
      expect(closed.height).toBeLessThan(price.height);
      expect(closed.blank).toBeLessThanOrEqual(24);

      // The stock's longest families are held to the same cap, and end where their metrics do.
      await chooseSource(panel, "STOCK");
      for (const [family, count] of [
        ["FUNDAMENTALS", 15],
        ["VALUATION", 12],
      ] as const) {
        await showFamily(panel, family);
        await expect(options).toHaveCount(count);
        const long = await measure();
        expect(long.height).toBeLessThanOrEqual(440);
        expect(long.blank).toBeLessThanOrEqual(24);
      }
      // Opened beneath the rule, the popover grows downward: its source and tabs never move at all.
      if (side === "below") {
        const top = (await sources.boundingBox())!.y;
        await showFamily(panel, "TECHNICAL");
        expect((await sources.boundingBox())!.y).toBe(top);
        await showFamily(panel, "ACTIVITY");
        expect((await sources.boundingBox())!.y).toBe(top);
      }
    });
  }

  test("is fully usable from the keyboard, and hands focus back to the rule", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E etf keyboard ${Date.now()}`);
    const control = row.getByTestId("metric-picker");
    await control.focus();
    await page.keyboard.press("Enter");
    const panel = row.getByTestId("metric-picker-panel");
    await expect(panel).toBeVisible();
    // Focus opens on the rule's own metric.
    const focusedValue = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-value"));
    await expect.poll(focusedValue).toBe("PRICE:");

    // The data source is a radio group: one arrow key moves the rule to an ETF.
    await sourceChoice(panel, "STOCK").focus();
    await page.keyboard.press("ArrowRight");
    await expect(sourceChoice(panel, "ETF")).toBeChecked();
    await expect(sourceChoice(panel, "ETF")).toBeFocused();
    await expect(control).toHaveText("SPY · Price");

    // Tab reaches the fund, then the family, then the library — in reading order.
    await page.keyboard.press("Tab");
    const select = panel.getByTestId("metric-picker-etf");
    await expect(select).toBeFocused();
    await select.selectOption("ETF_XLK");
    await expect(control).toHaveText("XLK · Price");
    await select.focus();
    await page.keyboard.press("Tab");
    await expect(
      panel.locator('[data-testid="metric-picker-family"][data-value="TECHNICAL"]'),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect.poll(focusedValue).toBe("PRICE");

    // Arrows walk the library: down through the open subgroup's metrics to the next header, where
    // Right opens it and Left closes it.
    await page.keyboard.press("ArrowDown");
    await expect.poll(focusedValue).toBe("ETF(ETF_XLK)|PRICE:");
    await page.keyboard.press("ArrowDown");
    await expect.poll(focusedValue).toBe("MOVING_AVERAGES");
    await page.keyboard.press("ArrowDown");
    await expect.poll(focusedValue).toBe("OSCILLATORS");
    const oscillators = panel.locator(
      '[data-testid="metric-picker-category"][data-value="OSCILLATORS"]',
    );
    await page.keyboard.press("ArrowRight");
    await expect(oscillators).toHaveAttribute("aria-expanded", "true");
    await expect(oscillators).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(oscillators).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect.poll(focusedValue).toBe("ETF(ETF_XLK)|OSCILLATOR:RSI_7D");
    await page.keyboard.press("ArrowRight");
    await expect.poll(focusedValue).toBe("ETF(ETF_XLK)|OSCILLATOR:RSI_14D");
    // The focused metric shows a ring of its own, not only a colour.
    await expect(
      panel.locator(
        '[data-testid="metric-picker-option"][data-value="ETF(ETF_XLK)|OSCILLATOR:RSI_14D"]',
      ),
    ).not.toHaveCSS("box-shadow", "none");

    // Enter chooses it, closes the popover, and returns focus to the rule's Metric control.
    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    await expect(control).toBeFocused();
    await expect(control).toHaveText("XLK · RSI 14D");
    await expect(control).toHaveAccessibleName("Metric: XLK · RSI 14D");

    // Reopened, it is on the rule again — source, fund, family, subgroup and metric — and Escape
    // closes it with nothing changed and focus back where it was.
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expectPickerOnEtf(panel, {
      code: "ETF_XLK",
      category: "OSCILLATORS",
      metric: "RSI 14D",
    });
    await expect
      .poll(focusedValue)
      .toBe("ETF(ETF_XLK)|OSCILLATOR:RSI_14D");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(control).toBeFocused();
    await expect(control).toHaveText("XLK · RSI 14D");
  });

  test("keeps what a change of source can keep, and says what it could not", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E etf outcomes ${Date.now()}`);
    const control = row.getByTestId("metric-picker");
    const operator = row.getByTestId("operator-select");
    const value = row.getByTestId("value-control");
    const notice = row.getByTestId("row-change-notice");

    // A threshold means the same on the stock and on an ETF: nothing is reset, and nothing is said.
    await chooseMetric(row, "OSCILLATORS", "OSCILLATOR:RSI_14D");
    await operator.selectOption("IS_BELOW");
    await value.fill("35");
    const panel = await openPicker(row);
    await chooseEtf(panel, "ETF_XLK");
    await expect(control).toHaveText("XLK · RSI 14D");
    await expect(operator).toHaveValue("IS_BELOW");
    await expect(value).toHaveValue("35");
    await expect(notice).toHaveCount(0);
    await expect(panel.getByTestId("metric-picker-hint")).toHaveCount(0);
    // Another fund, same metric: still nothing lost.
    await panel.getByTestId("metric-picker-etf").selectOption("ETF_XLF");
    await expect(control).toHaveText("XLF · RSI 14D");
    await expect(value).toHaveValue("35");
    await expect(notice).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "XLF · RSI 14D is below 35",
    );

    // Price against an intrinsic value has no ETF form: the Value cannot be kept, and the rule says
    // so — beneath the row and inside the open popover — instead of silently comparing something else.
    await chooseSource(await openPicker(row), "STOCK");
    await page.keyboard.press("Escape");
    await chooseMetric(row, "PRICE", "PRICE:");
    await chooseSeriesValue(row, "DCF_FCFF");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Price is above DCF (FCFF)",
    );
    const reopened = await openPicker(row);
    await chooseEtf(reopened, "ETF_GLD");
    await expect(control).toHaveText("GLD · Price");
    await expect(row.getByTestId("value-control")).toHaveAttribute(
      "data-value",
      "SMA_20D",
    );
    await expect(reopened.getByTestId("metric-picker-hint")).toHaveText(
      "Value was reset to match GLD · Price.",
    );
    await page.keyboard.press("Escape");
    await expect(notice).toHaveText("Value was reset to match GLD · Price.");
    await expect(notice).toHaveAttribute("role", "status");

    // A Fundamental has no ETF form at all: choosing ETF changes nothing until an ETF metric is
    // chosen, and the popover says what it is waiting for.
    await chooseSource(await openPicker(row), "STOCK");
    await page.keyboard.press("Escape");
    await chooseMetric(row, "FUNDAMENTALS", "FUNDAMENTAL:ROIC_TTM");
    await value.fill("15");
    const browsing = await openPicker(row);
    await chooseEtf(browsing, "ETF_XLV");
    await expect(browsing.getByTestId("metric-picker-hint")).toHaveText(
      "ROIC TTM is read from the stock only. Choose a metric below to read XLV instead.",
    );
    await expect(control).toHaveText("ROIC TTM");
    expect(await familyLabels(browsing)).toEqual(["Technical"]);
    // Leaving without choosing leaves the rule exactly as it was.
    await page.keyboard.press("Escape");
    await expect(control).toHaveAttribute("data-value", "FUNDAMENTAL:ROIC_TTM");
    await expect(value).toHaveValue("15");
    await expect(sourceChoice(await openPicker(row), "STOCK")).toBeChecked();
    await page.keyboard.press("Escape");
    // Choosing an ETF metric is the edit, and its outcome is stated.
    await chooseEtfMetric(
      row,
      "ETF_XLV",
      "VOLUME",
      "ETF(ETF_XLV)|RELATIVE_VOLUME:20",
    );
    await expect(control).toHaveText("XLV · RVOL 20");
    await expect(notice).toHaveText("Value was reset to match XLV · RVOL 20.");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "XLV · RVOL 20 is above 1.0x",
    );
    // A Value of the user's own retires the notice: it reported a reset, not the rule.
    await row.getByTestId("value-control").fill("2");
    await expect(notice).toHaveCount(0);
  });

  test("authors independent stock and ETF conditions in BUY, SELL and FINAL EXIT, through save, reload, edit and duplicate", async ({
    page,
  }) => {
    const name = `E2E etf mixed ${Date.now()}`;
    let sourceId: string | null = null;
    let copyId: string | null = null;
    try {
      await startStrategy(page, name);
      const buy = page.getByTestId("level-card-BUY").first();
      for (let added = 0; added < 3; added += 1) {
        await buy.getByTestId("add-condition").click();
      }
      const [growth, xlk, spy, gld] = await buy
        .getByTestId("predicate-row")
        .all();

      // The decision's own example: four independent sources in one BUY signal.
      await chooseMetric(
        growth!,
        "FUNDAMENTALS",
        "FUNDAMENTAL:REVENUE_GROWTH_TTM_YOY",
      );
      await growth!.getByTestId("value-control").fill("15");
      await chooseEtfMetric(
        xlk!,
        "ETF_XLK",
        "OSCILLATORS",
        "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
      );
      await chooseEtfMetric(spy!, "SP500", "PRICE", "ETF(SP500)|PRICE:");
      await chooseSeriesValue(spy!, "SMA_200D");
      await chooseEtfMetric(
        gld!,
        "ETF_GLD",
        "VOLUME",
        "ETF(ETF_GLD)|RELATIVE_VOLUME:20",
      );
      await gld!.getByTestId("value-control").fill("1.5");

      // An ETF Price compares with that ETF's own moving averages, and with nothing of a company.
      const spyValues = await openPicker(spy!, "value-control");
      expect(await categoryLabels(spyValues)).toEqual([
        "Moving averages — Daily",
        "Moving averages — Weekly",
      ]);
      await page.keyboard.press("Escape");

      // SELL: the position's own Gain beside an ETF condition.
      await page.getByTestId("add-level-SELL").click();
      const sell = page.getByTestId("level-card-SELL").first();
      await sell.getByTestId("add-condition").click();
      const [gain, qqq] = await sell.getByTestId("predicate-row").all();
      await chooseMetric(gain!, "POSITION", "GAIN:");
      await gain!.getByTestId("value-control").fill("25");
      await chooseEtfMetric(
        qqq!,
        "ETF_QQQ",
        "OSCILLATORS",
        "ETF(ETF_QQQ)|OSCILLATOR:RSI_14D",
      );
      await qqq!.getByTestId("value-control").fill("70");
      // An ETF never offers Position, even where the stock does.
      const sellPanel = await openPicker(qqq!);
      expect(await familyLabels(sellPanel)).toEqual(["Technical"]);
      await page.keyboard.press("Escape");
      const gainPanel = await openPicker(gain!);
      expect(await familyLabels(gainPanel)).toContain("Position");
      await page.keyboard.press("Escape");

      // FINAL EXIT: a stock rule and an ETF rule in one Exit Rule.
      await page.getByTestId("add-level-FINAL_EXIT").click();
      const exit = page.getByTestId("level-card-FINAL_EXIT");
      await exit.getByTestId("add-condition").click();
      const [stockExit, tltExit] = await exit.getByTestId("predicate-row").all();
      await chooseMetric(stockExit!, "PRICE", "PRICE:");
      await stockExit!.getByTestId("operator-select").selectOption("IS_BELOW");
      await chooseSeriesValue(stockExit!, "SMA_200D");
      await chooseEtfMetric(
        tltExit!,
        "ETF_TLT",
        "MOVING_AVERAGES",
        "ETF(ETF_TLT)|MOVING_AVERAGE:SMA_50D",
      );
      await tltExit!.getByTestId("operator-select").selectOption("IS_BELOW");
      await chooseSeriesValue(tltExit!, "SMA_200D");

      // Still three controls a rule: the source lives inside the Metric popover alone.
      await expect(xlk!.getByTestId("metric-picker")).toBeVisible();
      await expect(xlk!.getByTestId("operator-select")).toBeVisible();
      await expect(xlk!.getByTestId("value-control")).toBeVisible();
      await expect(xlk!.getByTestId("metric-picker-etf")).toHaveCount(0);
      await expect(xlk!.getByTestId("operand-config-button")).toHaveCount(0);

      const sentences = [
        "Revenue Growth TTM YoY is above 15%",
        "XLK · RSI 14D is above 50",
        "SPY · Price is above SMA 200D",
        "GLD · RVOL 20 is above 1.5x",
        "Gain is above 25%",
        "QQQ · RSI 14D is above 70",
        "Price is below SMA 200D",
        "TLT · SMA 50D is below SMA 200D",
      ];
      const controls = [
        "Revenue Growth TTM YoY",
        "XLK · RSI 14D",
        "SPY · Price",
        "GLD · RVOL 20",
        "Gain",
        "QQQ · RSI 14D",
        "Price",
        "TLT · SMA 50D",
      ];
      const expectBuilderReads = async (
        expectedControls: readonly string[],
        expectedSentences: readonly string[],
      ) => {
        await expect(
          page.getByTestId("strategy-builder").getByTestId("metric-picker"),
        ).toHaveText([...expectedControls]);
        expect(await previewSentences(page)).toEqual([...expectedSentences]);
      };
      await expectBuilderReads(controls, sentences);

      // The explanation says where the number comes from, and when it cannot be read.
      await xlk!.getByTestId("metric-picker").focus();
      const help = page.getByTestId("explanation-panel");
      await expect(help.getByRole("heading")).toHaveText("XLK · RSI 14D");
      await expect(help.getByTestId("help-notes")).toContainText(
        "Read from XLK (Technology) rather than the evaluated stock",
      );
      await expect(help.getByTestId("help-not-evaluable")).toContainText(
        "The ETF has no completed, synchronized session for the date",
      );
      await expectNoHorizontalScroll(page);

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      sourceId = strategyIdOf(page);

      // Stored as the stable benchmark code — SPY is the SP500 series — and nowhere a ticker; a
      // stock rule carries no source field at all.
      const saved = await readStrategy(page, sourceId);
      expect(saved.versionNumber).toBe(1);
      expect(saved.definition.buyLevels[0]?.signal.conditions.map(rule)).toEqual(
        [
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
        ],
      );
      expect(
        saved.definition.sellLevels[0]?.signal.conditions.map(rule),
      ).toEqual([
        {
          metric: { kind: "GAIN" },
          operator: "IS_ABOVE",
          value: { kind: "PERCENT", value: 25 },
        },
        {
          metric: {
            kind: "OSCILLATOR",
            seriesId: "RSI_14D",
            source: { kind: "ETF", code: "ETF_QQQ" },
          },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 70 },
        },
      ]);
      expect(
        saved.definition.finalExit?.rules[0]?.signal.conditions.map(rule),
      ).toEqual([
        {
          metric: { kind: "PRICE" },
          operator: "IS_BELOW",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
        {
          metric: {
            kind: "MOVING_AVERAGE",
            seriesId: "SMA_50D",
            source: { kind: "ETF", code: "ETF_TLT" },
          },
          operator: "IS_BELOW",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
      ]);
      expect(JSON.stringify(saved.definition)).not.toMatch(
        /"(SPY|XLK|GLD|QQQ|TLT)"/,
      );

      // Reload reconstructs exactly the same state, and reopening a rule shows its own source,
      // fund, family, subgroup and metric.
      await page.reload();
      await expectBuilderReads(controls, sentences);
      await expect(page.getByTestId("save-strategy")).toBeDisabled();
      const reloadedXlk = rows(page, "level-card-BUY").nth(1);
      const reopened = await openPicker(reloadedXlk);
      await expectPickerOnEtf(reopened, {
        code: "ETF_XLK",
        category: "OSCILLATORS",
        metric: "RSI 14D",
      });

      // Edit one rule's fund: the metric, the operator and the Value stay, and only that rule moves.
      await reopened.getByTestId("metric-picker-etf").selectOption("ETF_XLF");
      await page.keyboard.press("Escape");
      await expect(reloadedXlk.getByTestId("row-change-notice")).toHaveCount(0);
      const editedControls = controls.map((text) =>
        text === "XLK · RSI 14D" ? "XLF · RSI 14D" : text,
      );
      const editedSentences = sentences.map((text) =>
        text === "XLK · RSI 14D is above 50" ? "XLF · RSI 14D is above 50" : text,
      );
      await expectBuilderReads(editedControls, editedSentences);
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      await page.reload();
      await expectBuilderReads(editedControls, editedSentences);
      const edited = await readStrategy(page, sourceId);
      // A new immutable version: the fund is part of the rule's identity.
      expect(edited.versionNumber).toBe(2);
      expect(
        edited.definition.buyLevels[0]?.signal.conditions.map(rule)[1],
      ).toEqual({
        metric: {
          kind: "OSCILLATOR",
          seriesId: "RSI_14D",
          source: { kind: "ETF", code: "ETF_XLF" },
        },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 50 },
      });

      // Duplicate from the collection: the copy holds the same logic and reads the same.
      await page.goto("/strategies");
      const collectionRow = page
        .getByTestId("strategies-grid")
        .locator("tbody tr")
        .filter({ hasText: name });
      await chooseFromOverflowMenu(page, name, "Duplicate", collectionRow);
      const dialog = page.getByTestId("duplicate-dialog");
      await dialog.getByLabel("Name").fill(`${name} (copy)`);
      await dialog.getByLabel("Name").press("Enter");
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expectBuilderReads(editedControls, editedSentences);
      const copy = await readStrategy(page, copyId);
      expect(withoutIds(copy.definition)).toEqual(
        withoutIds(edited.definition),
      );
    } finally {
      await deleteStrategies(page, [copyId, sourceId]);
    }
  });

  test("validates ETF rules where the user is, and the API refuses what the Builder never offers", async ({
    page,
  }) => {
    const name = `E2E etf validation ${Date.now()}`;
    const row = await startStrategy(page, name);
    const buy = page.getByTestId("level-card-BUY").first();
    await chooseEtfMetric(
      row,
      "ETF_XLK",
      "OSCILLATORS",
      "ETF(ETF_XLK)|OSCILLATOR:RSI_14D",
    );

    // The same metric of the stock, and of another fund, are three different rules …
    await buy.getByTestId("add-condition").click();
    await buy.getByTestId("add-condition").click();
    const [, stock, other] = await buy.getByTestId("predicate-row").all();
    await chooseMetric(stock!, "OSCILLATORS", "OSCILLATOR:RSI_14D");
    await chooseEtfMetric(
      other!,
      "ETF_XLF",
      "OSCILLATORS",
      "ETF(ETF_XLF)|OSCILLATOR:RSI_14D",
    );
    await expect(page.getByTestId("save-strategy")).toBeEnabled();
    await expect(page.getByTestId("issue-count")).toHaveCount(0);

    // … and the same fund twice is one rule repeated, reported on the row that repeats it.
    await other!.getByTestId("metric-picker").click();
    await other!.getByTestId("metric-picker-etf").selectOption("ETF_XLK");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("save-strategy")).toBeDisabled();
    await page.getByTestId("issue-count").click();
    await expect(other!.getByRole("alert")).toContainText(
      "This condition repeats condition 1.",
    );
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(stock!.getByRole("alert")).toHaveCount(0);

    // An empty threshold is asked for on the ETF rule exactly as on any other.
    await other!.getByTestId("metric-picker").click();
    await other!.getByTestId("metric-picker-etf").selectOption("ETF_XLF");
    await page.keyboard.press("Escape");
    await other!.getByTestId("value-control").fill("");
    await expect(page.getByTestId("save-strategy")).toBeDisabled();
    await page.getByTestId("issue-count").click();
    await expect(other!.getByRole("alert")).toBeVisible();
    await expect(other!.getByTestId("value-control")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await other!.getByTestId("value-control").fill("45");
    await expect(page.getByTestId("save-strategy")).toBeEnabled();

    // A Trigger is offered no ETF: the choice is on show, disabled, with the reason beside it.
    await buy.getByTestId("add-trigger").click();
    const trigger = buy.getByTestId("predicate-row").last();
    const triggerPanel = await openPicker(trigger);
    await expect(sourceChoice(triggerPanel, "ETF")).toBeDisabled();
    await expect(triggerPanel.getByTestId("metric-picker-hint")).toHaveText(
      "An ETF or the stock's sector can be read by a condition only, not by a trigger.",
    );
    await expect(triggerPanel.getByTestId("metric-picker-etf")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // …while the conditions of the same signal keep theirs.
    await expect(sourceChoice(await openPicker(row), "ETF")).toBeChecked();
    await page.keyboard.press("Escape");

    // What the Builder cannot author, the API refuses by name rather than storing or reinterpreting.
    const refuse = async (
      definition: unknown,
    ): Promise<{ code: string; message: string }[]> => {
      const response = await page.request.post(`${apiBaseUrl()}/strategies`, {
        data: { name: `${name} refused`, definition },
      });
      expect(response.status()).toBe(400);
      const body = (await response.json()) as {
        issues: { code: string; message: string }[];
      };
      return body.issues.map(({ code, message }) => ({ code, message }));
    };
    const buyLevel = (signal: unknown) => ({
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "b1", percentage: 100, signal }],
      sellLevels: [],
    });
    const condition = (metric: unknown) => ({
      id: "c1",
      metric,
      operator: "IS_ABOVE",
      value: { kind: "NUMBER", value: 50 },
    });

    // An ETF the product does not offer.
    expect(
      await refuse(
        buyLevel({
          conditions: [
            condition({
              kind: "OSCILLATOR",
              seriesId: "RSI_14D",
              source: { kind: "ETF", code: "ETF_ARKK" },
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        code: "SOURCE_INVALID",
        message: "`ETF_ARKK` is not an ETF this product offers.",
      },
    ]);
    // A ticker is a display name, never an identity.
    expect(
      (
        await refuse(
          buyLevel({
            conditions: [
              condition({
                kind: "OSCILLATOR",
                seriesId: "RSI_14D",
                source: { kind: "ETF", code: "XLK" },
              }),
            ],
          }),
        )
      ).map((issue) => issue.code),
    ).toEqual(["SOURCE_INVALID"]);
    // A stock-only metric with a source.
    expect(
      (
        await refuse(
          buyLevel({
            conditions: [
              {
                id: "c1",
                metric: {
                  kind: "FUNDAMENTAL",
                  metricId: "ROIC_TTM",
                  source: { kind: "ETF", code: "ETF_XLK" },
                },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 15 },
              },
            ],
          }),
        )
      ).map((issue) => issue.code),
    ).toEqual(["UNKNOWN_FIELD"]);
    // An ETF-sourced Trigger.
    expect(
      await refuse(
        buyLevel({
          conditions: [],
          trigger: {
            id: "t1",
            metric: {
              kind: "OSCILLATOR",
              seriesId: "RSI_14D",
              source: { kind: "ETF", code: "ETF_XLK" },
            },
            operator: "CROSSES_ABOVE",
            value: { kind: "NUMBER", value: 50 },
          },
        }),
      ),
    ).toEqual([
      {
        code: "SOURCE_NOT_ALLOWED_IN_PART",
        message:
          "XLK · RSI 14D reads an ETF, so it can be used as a condition only, not as a trigger.",
      },
    ]);
    // An ETF Price against an intrinsic value: a company's number, which a fund does not have.
    expect(
      (
        await refuse(
          buyLevel({
            conditions: [
              {
                id: "c1",
                metric: { kind: "PRICE", source: { kind: "ETF", code: "SP500" } },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "DCF_FCFF" },
              },
            ],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

/** What the picker says in place of a fund select when Stock's Sector is the source. */
const SECTOR_NOTE =
  "Each stock reads the sector ETF of its own FMP sector — Technology reads XLK, Financial Services reads XLF, Energy reads XLE. A stock without one of the eleven sectors cannot be evaluated.";

test.describe("Stock's Sector in the Strategy Builder", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("offers Stock's Sector as a third source: no fund to choose, the same 21 metrics, said plainly, keyboard included", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E sector source ${Date.now()}`);
    const control = row.getByTestId("metric-picker");
    const panel = await openPicker(row);

    // Three sources, in the decision's order, in the one compact radio group.
    const sources = panel.getByTestId("metric-picker-source");
    await expect(sources).toHaveCount(3);
    expect(
      await panel
        .getByTestId("metric-picker-sources")
        .locator("label")
        .allTextContents(),
    ).toEqual(["Stock", "ETF", "Stock's Sector"]);
    await expect(sourceChoice(panel, "STOCK_SECTOR")).toBeEnabled();

    await chooseSource(panel, "STOCK_SECTOR");
    // No fund is asked for — the stock's own sector chooses it — and the line says how.
    await expect(panel.getByTestId("metric-picker-etf")).toHaveCount(0);
    await expect(panel.getByTestId("metric-picker-sector-note")).toHaveText(SECTOR_NOTE);
    await expect(control).toHaveText("Stock's Sector · Price");
    await expect(control).toHaveAttribute("data-value", "STOCK_SECTOR|PRICE:");
    await expect(control).toHaveAccessibleName("Metric: Stock's Sector · Price");

    // Technical alone, four subgroups, exactly the 21 metrics an ETF offers.
    expect(await familyLabels(panel)).toEqual(["Technical"]);
    const offered: string[] = [];
    for (const [category, metrics] of Object.entries(ETF_METRICS)) {
      await showCategory(panel, category);
      expect(await optionLabels(panel)).toEqual([...metrics]);
      offered.push(...(await optionLabels(panel)));
    }
    expect(offered).toHaveLength(21);
    await showCategory(panel, "OSCILLATORS");
    await panel
      .locator(
        '[data-testid="metric-picker-option"][data-value="STOCK_SECTOR|OSCILLATOR:RSI_14D"]',
      )
      .click();
    await expect(panel).toBeHidden();
    await expect(control).toHaveText("Stock's Sector · RSI 14D");
    expect(await previewSentences(page)).toEqual([
      "Stock's Sector · RSI 14D is above 50",
    ]);

    // The explanation names the rule, its examples and its limitation.
    await control.focus();
    const help = page.getByTestId("explanation-panel");
    await expect(help.getByRole("heading")).toHaveText("Stock's Sector · RSI 14D");
    await expect(help.getByTestId("help-notes")).toContainText("Technology reads XLK");
    await expect(help.getByTestId("help-notes")).toContainText("current");
    await expect(help.getByTestId("help-not-evaluable")).toContainText(
      "Another fund is never used instead.",
    );

    // From the keyboard: the arrows walk Stock → ETF → Stock's Sector → Stock, the rule following.
    await control.press("Enter");
    await expect(panel).toBeVisible();
    await expect(sourceChoice(panel, "STOCK_SECTOR")).toBeChecked();
    await sourceChoice(panel, "STOCK_SECTOR").focus();
    await page.keyboard.press("ArrowRight");
    await expect(sourceChoice(panel, "STOCK")).toBeChecked();
    await expect(control).toHaveText("RSI 14D");
    await page.keyboard.press("ArrowRight");
    await expect(sourceChoice(panel, "ETF")).toBeChecked();
    await expect(control).toHaveText("SPY · RSI 14D");
    await page.keyboard.press("ArrowRight");
    await expect(sourceChoice(panel, "STOCK_SECTOR")).toBeChecked();
    await expect(sourceChoice(panel, "STOCK_SECTOR")).toBeFocused();
    await expect(control).toHaveText("Stock's Sector · RSI 14D");
    await expect(panel.getByTestId("metric-picker-etf")).toHaveCount(0);
    // Tab goes from the sources straight to the family: there is no fund control to pass through.
    await page.keyboard.press("Tab");
    await expect(
      panel.locator('[data-testid="metric-picker-family"][data-value="TECHNICAL"]'),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(control).toBeFocused();

    // A Trigger row offers it disabled, with the reason.
    const buy = page.getByTestId("level-card-BUY").first();
    await buy.getByTestId("add-trigger").click();
    const triggerRow = buy.getByTestId("predicate-row").last();
    const triggerPanel = await openPicker(triggerRow);
    await expect(sourceChoice(triggerPanel, "STOCK_SECTOR")).toBeDisabled();
    await expect(triggerPanel.getByTestId("metric-picker-hint")).toHaveText(
      "An ETF or the stock's sector can be read by a condition only, not by a trigger.",
    );
    await page.keyboard.press("Escape");
    await expectNoHorizontalScroll(page);
  });

  test("authors Stock, ETF and Stock's Sector rules in BUY, SELL and FINAL EXIT through save, reload, edit and duplicate", async ({
    page,
  }) => {
    const name = `E2E sector mixed ${Date.now()}`;
    let sourceId: string | null = null;
    let copyId: string | null = null;
    try {
      await startStrategy(page, name);
      const buy = page.getByTestId("level-card-BUY").first();
      await buy.getByTestId("add-condition").click();
      await buy.getByTestId("add-condition").click();
      const [stock, xlk, sector] = await buy.getByTestId("predicate-row").all();
      await chooseMetric(stock!, "OSCILLATORS", "OSCILLATOR:RSI_14D");
      await chooseEtfMetric(xlk!, "ETF_XLK", "OSCILLATORS", "ETF(ETF_XLK)|OSCILLATOR:RSI_14D");

      // A Price compared with an intrinsic value cannot keep that Value under Stock's Sector: the
      // rule is reset to the sector metric's own starting rule, and says so.
      await sector!.getByTestId("operator-select").selectOption("IS_BELOW");
      await chooseSeriesValue(sector!, "BALANCED");
      const panel = await openPicker(sector!);
      await chooseSource(panel, "STOCK_SECTOR");
      const sentence = "Condition and value were reset to match Stock's Sector · Price.";
      await expect(panel.getByTestId("metric-picker-hint")).toHaveText(sentence);
      await page.keyboard.press("Escape");
      await expect(sector!.getByTestId("row-change-notice")).toHaveText(sentence);
      await expect(sector!.getByTestId("value-control")).toHaveAttribute(
        "data-value",
        "SMA_20D",
      );
      // Its Value list is the sector fund's own moving averages.
      const values = await openPicker(sector!, "value-control");
      expect(await categoryLabels(values)).toEqual([
        "Moving averages — Daily",
        "Moving averages — Weekly",
      ]);
      await page.keyboard.press("Escape");
      await chooseSeriesValue(sector!, "SMA_200D");
      await expect(sector!.getByTestId("row-change-notice")).toHaveCount(0);

      // SELL and FINAL EXIT each read the stock's sector too.
      await page.getByTestId("add-level-SELL").click();
      const sell = rows(page, "level-card-SELL").first();
      await chooseSectorMetric(sell, "OSCILLATORS", "STOCK_SECTOR|OSCILLATOR:RSI_14D");
      await sell.getByTestId("value-control").fill("70");
      await page.getByTestId("add-level-FINAL_EXIT").click();
      const exit = rows(page, "level-card-FINAL_EXIT").first();
      await chooseSectorMetric(exit, "PRICE", "STOCK_SECTOR|PRICE:");
      await exit.getByTestId("operator-select").selectOption("IS_BELOW");
      await chooseSeriesValue(exit, "SMA_50D");

      const controls = [
        "RSI 14D",
        "XLK · RSI 14D",
        "Stock's Sector · Price",
        "Stock's Sector · RSI 14D",
        "Stock's Sector · Price",
      ];
      const sentences = [
        "RSI 14D is above 50",
        "XLK · RSI 14D is above 50",
        "Stock's Sector · Price is above SMA 200D",
        "Stock's Sector · RSI 14D is above 70",
        "Stock's Sector · Price is below SMA 50D",
      ];
      const expectBuilderReads = async (
        expectedControls: readonly string[],
        expectedSentences: readonly string[],
      ) => {
        await expect(
          page.getByTestId("strategy-builder").getByTestId("metric-picker"),
        ).toHaveText([...expectedControls]);
        expect(await previewSentences(page)).toEqual([...expectedSentences]);
      };
      await expectBuilderReads(controls, sentences);
      // Still three controls a rule.
      await expect(sector!.getByTestId("metric-picker-etf")).toHaveCount(0);
      await expect(sector!.getByTestId("operand-config-button")).toHaveCount(0);

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      sourceId = strategyIdOf(page);
      const saved = await readStrategy(page, sourceId);
      // Stored as the source kind alone: no fund, no ticker, no sector name.
      expect(saved.definition.buyLevels[0]?.signal.conditions.map(rule)).toEqual([
        {
          metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 50 },
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
          metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
          operator: "IS_ABOVE",
          value: { kind: "SERIES", seriesId: "SMA_200D" },
        },
      ]);
      expect(saved.definition.sellLevels[0]?.signal.conditions.map(rule)).toEqual([
        {
          metric: {
            kind: "OSCILLATOR",
            seriesId: "RSI_14D",
            source: { kind: "STOCK_SECTOR" },
          },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 70 },
        },
      ]);
      expect(saved.definition.finalExit?.rules[0]?.signal.conditions.map(rule)).toEqual([
        {
          metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
          operator: "IS_BELOW",
          value: { kind: "SERIES", seriesId: "SMA_50D" },
        },
      ]);

      // Reload: the same rules, and the sector rule reopens on its own source with no fund shown.
      await page.reload();
      await expectBuilderReads(controls, sentences);
      await expect(page.getByTestId("save-strategy")).toBeDisabled();
      const reloadedSector = rows(page, "level-card-BUY").nth(2);
      const reopened = await openPicker(reloadedSector);
      await expect(sourceChoice(reopened, "STOCK_SECTOR")).toBeChecked();
      await expect(reopened.getByTestId("metric-picker-etf")).toHaveCount(0);
      await expect(reopened.getByTestId("metric-picker-sector-note")).toBeVisible();
      await expect(
        reopened.locator('[data-testid="metric-picker-option"][aria-pressed="true"]'),
      ).toHaveText("Price");
      await page.keyboard.press("Escape");

      // Edit: the SELL rule's sector RSI threshold. A new version, the source untouched.
      await rows(page, "level-card-SELL").first().getByTestId("value-control").fill("65");
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      const editedSentences = sentences.map((text) =>
        text === "Stock's Sector · RSI 14D is above 70"
          ? "Stock's Sector · RSI 14D is above 65"
          : text,
      );
      await page.reload();
      await expectBuilderReads(controls, editedSentences);
      const edited = await readStrategy(page, sourceId);
      expect(edited.versionNumber).toBe(2);
      expect(edited.definition.sellLevels[0]?.signal.conditions.map(rule)[0]).toEqual({
        metric: {
          kind: "OSCILLATOR",
          seriesId: "RSI_14D",
          source: { kind: "STOCK_SECTOR" },
        },
        operator: "IS_ABOVE",
        value: { kind: "NUMBER", value: 65 },
      });

      // Duplicate: the copy reads and stores the same logic.
      await page.goto("/strategies");
      const collectionRow = page
        .getByTestId("strategies-grid")
        .locator("tbody tr")
        .filter({ hasText: name });
      await chooseFromOverflowMenu(page, name, "Duplicate", collectionRow);
      const dialog = page.getByTestId("duplicate-dialog");
      await dialog.getByLabel("Name").fill(`${name} (copy)`);
      await dialog.getByLabel("Name").press("Enter");
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expectBuilderReads(controls, editedSentences);
      const copy = await readStrategy(page, copyId);
      expect(withoutIds(copy.definition)).toEqual(withoutIds(edited.definition));
    } finally {
      await deleteStrategies(page, [copyId, sourceId]);
    }
  });
});

test.describe("ETF conditions on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("chooses a fund and a metric from a bottom sheet with thumb-sized targets, and saves it", async ({
    page,
  }) => {
    const name = `E2E etf phone ${Date.now()}`;
    let id: string | null = null;
    try {
      const row = await startStrategy(page, name);
      const viewport = page.viewportSize()!;
      const sheet = await openPicker(row);

      // A bottom sheet: the whole width, on the bottom edge, over a scrim.
      const onTheBottomEdge = async () => {
        const box = (await sheet.boundingBox())!;
        expect(Math.round(box.x)).toBe(0);
        expect(Math.round(box.width)).toBe(viewport.width);
        expect(Math.round(box.y + box.height)).toBe(viewport.height);
        return box;
      };
      const stockSheet = await onTheBottomEdge();
      await expect(page.getByTestId("metric-picker-scrim")).toBeVisible();

      // Stock or ETF, then the fund from the platform's own grouped picker.
      await chooseSource(sheet, "ETF");
      const select = sheet.getByTestId("metric-picker-etf");
      await expect(select).toBeInViewport();
      expect(
        await select
          .locator("optgroup")
          .evaluateAll((groups) =>
            groups.map((group) => group.getAttribute("label")),
          ),
      ).toEqual(ETF_GROUPS.map((group) => group.label));
      await expect(select.locator("option")).toHaveCount(20);
      await select.selectOption("ETF_XLRE");
      await expect(row.getByTestId("metric-picker")).toHaveText("XLRE · Price");

      // Everything that is pressed is a comfortable target, and nothing runs off the side.
      const targets = [
        ...(await sheet.locator('[class*="sourceFace"]').all()),
        select,
        ...(await sheet.getByTestId("metric-picker-family").all()),
        ...(await sheet.getByTestId("metric-picker-category").all()),
        ...(await sheet.getByTestId("metric-picker-option").all()),
      ];
      expect(targets.length).toBeGreaterThanOrEqual(8);
      for (const target of targets) {
        const box = (await target.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(38);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      await expectNoHorizontalScroll(page);

      // An ETF's sheet is shorter than the stock's was not: it is as tall as its four lines and one
      // metric, never a full-height panel of blank space.
      const etfSheet = await onTheBottomEdge();
      expect(etfSheet.height).toBeLessThan(viewport.height * 0.6);
      expect(stockSheet.height).toBeLessThan(viewport.height * 0.8 + 1);

      // The longest subgroup keeps the source and the families in place and scrolls only its list.
      const sourceTop = async () =>
        (await sheet.getByTestId("metric-picker-sources").boundingBox())!.y;
      await showCategory(sheet, "MOVING_AVERAGES");
      const options = sheet.getByTestId("metric-picker-option");
      await expect(options).toHaveCount(14);
      await onTheBottomEdge();
      const before = await sourceTop();
      expect(before).toBeGreaterThanOrEqual(0);
      await sheet
        .getByTestId("metric-picker-options")
        .evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await expect(
        sheet.getByTestId("metric-picker-category").last(),
      ).toBeInViewport();
      expect(await sourceTop()).toBe(before);
      await expect(sheet.getByTestId("metric-picker-sources")).toBeInViewport();

      // Choosing closes the sheet; the rule names its fund on its own line.
      await sheet
        .locator(
          '[data-testid="metric-picker-option"][data-value="ETF(ETF_XLRE)|MOVING_AVERAGE:EMA_200W"]',
        )
        .click();
      await expect(sheet).toBeHidden();
      await expect(page.getByTestId("metric-picker-scrim")).toHaveCount(0);
      const control = row.getByTestId("metric-picker");
      await expect(control).toHaveText("XLRE · EMA 200W");
      const controlBox = (await control.boundingBox())!;
      expect(controlBox.height).toBeGreaterThanOrEqual(40);
      expect(
        await control
          .locator("span")
          .first()
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      // What the change replaced is said under the row, across its whole width.
      const notice = row.getByTestId("row-change-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toHaveText(
        /reset to match XLRE · EMA 200W\.$/,
      );
      await expectNoHorizontalScroll(page);

      // A tap on the scrim leaves the rule exactly as it was.
      await openPicker(row);
      await page
        .getByTestId("metric-picker-scrim")
        .click({ position: { x: 10, y: 10 } });
      await expect(sheet).toBeHidden();
      await expect(control).toHaveText("XLRE · EMA 200W");

      // A second, stock condition beside it — and the pair saves and reloads as built.
      const buy = page.getByTestId("level-card-BUY").first();
      await buy.getByTestId("add-condition").click();
      const second = buy.getByTestId("predicate-row").nth(1);
      await chooseMetric(second, "OSCILLATORS", "OSCILLATOR:RSI_14D");
      await second.getByTestId("operator-select").selectOption("IS_BELOW");
      await second.getByTestId("value-control").fill("40");
      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(
        saved.definition.buyLevels[0]?.signal.conditions.map(
          (condition) => condition.metric,
        ),
      ).toEqual([
        {
          kind: "MOVING_AVERAGE",
          seriesId: "EMA_200W",
          source: { kind: "ETF", code: "ETF_XLRE" },
        },
        { kind: "OSCILLATOR", seriesId: "RSI_14D" },
      ]);
      await page.reload();
      await expect(
        page.getByTestId("strategy-builder").getByTestId("metric-picker"),
      ).toHaveText(["XLRE · EMA 200W", "RSI 14D"]);
      const reopened = await openPicker(rows(page, "level-card-BUY").first());
      await expectPickerOnEtf(reopened, {
        code: "ETF_XLRE",
        category: "MOVING_AVERAGES",
        metric: "EMA 200W",
      });
      await expectNoHorizontalScroll(page);
    } finally {
      await deleteStrategies(page, [id]);
    }
  });

  test("chooses Stock's Sector from the bottom sheet: three sources fit, the note wraps, and it saves", async ({
    page,
  }) => {
    const name = `E2E sector phone ${Date.now()}`;
    let id: string | null = null;
    try {
      const row = await startStrategy(page, name);
      const viewport = page.viewportSize()!;
      const sheet = await openPicker(row);
      await chooseSource(sheet, "STOCK_SECTOR");
      await expect(row.getByTestId("metric-picker")).toHaveText("Stock's Sector · Price");
      const note = sheet.getByTestId("metric-picker-sector-note");
      await expect(note).toBeInViewport();
      await expect(note).toHaveText(SECTOR_NOTE);
      // The three sources are thumb-sized and on screen; the note wraps inside the sheet.
      for (const face of await sheet.locator('[class*="sourceFace"]').all()) {
        const box = (await face.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(38);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      const noteBox = (await note.boundingBox())!;
      expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(viewport.width);
      await expectNoHorizontalScroll(page);
      // As tall as what it shows: a source line, a note, the family and the four subgroups.
      expect((await sheet.boundingBox())!.height).toBeLessThan(viewport.height * 0.6);

      await showCategory(sheet, "VOLUME");
      await sheet
        .locator(
          '[data-testid="metric-picker-option"][data-value="STOCK_SECTOR|RELATIVE_VOLUME:50"]',
        )
        .click();
      await expect(sheet).toBeHidden();
      const control = row.getByTestId("metric-picker");
      await expect(control).toHaveText("Stock's Sector · RVOL 50");
      expect(
        await control
          .locator("span")
          .first()
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await row.getByTestId("value-control").fill("1.5");
      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(saved.definition.buyLevels[0]?.signal.conditions.map(rule)).toEqual([
        {
          metric: {
            kind: "RELATIVE_VOLUME",
            period: 50,
            source: { kind: "STOCK_SECTOR" },
          },
          operator: "IS_ABOVE",
          value: { kind: "MULTIPLE", value: 1.5 },
        },
      ]);
      await page.reload();
      await expect(
        page.getByTestId("strategy-builder").getByTestId("metric-picker"),
      ).toHaveText(["Stock's Sector · RVOL 50"]);
      await expectNoHorizontalScroll(page);
    } finally {
      await deleteStrategies(page, [id]);
    }
  });
});
