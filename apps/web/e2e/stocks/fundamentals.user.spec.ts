import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRICS_LABEL,
  type FundamentalMetricId,
  type FundamentalMetricUnit,
} from "@intrinsic/contracts";
import {
  QA_FUNDAMENTAL_HISTORY_WEEKS,
  qaFundamentalValue,
  type QaFundamentalMetricId,
} from "@intrinsic/testing/qa-fundamentals";
import { expect, test, type Locator, type Page } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * Stock Details Fundamental Metrics for PRO_USER, through the real Next + Nest + PostgreSQL + Redis
 * stack.
 *
 * `QATEST1`'s Fundamental Metrics are the persisted readings of `QA_FUNDAMENTAL_STRETCHES` in
 * `@intrinsic/testing`, written by `pnpm test:securities:seed` onto its daily derived state. Every
 * expectation below is derived from that one table and the seeded calendar — 160 complete
 * Monday-Friday weeks ending on the chart's newest bar — never from the page itself: which value a
 * session holds, where each step and each gap starts, and the text a reading must display.
 *
 * Lines live on a canvas, so the chart's DOM contract is what is asserted — `data-fundamental*`,
 * including every transition the drawn line makes as `date=value` — together with the hover legend,
 * which names the metric and prints its reading (or `Unavailable`) for the session under the
 * pointer, and the network request each choice causes.
 */

const QA_SYMBOL = "QATEST1";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const DAY = 86_400_000;

/**
 * How each fixture reading must read, written out by hand: the oracle for the page's formatting,
 * independent of the formatter under test. `0.75` must never become `0.8x`, `1` reads `1.0x`, a
 * percentage is percentage points and never rescaled.
 */
const DISPLAY: Readonly<Record<string, string>> = {
  "PERCENT:12.5": "12.5%",
  "PERCENT:18.25": "18.25%",
  "PERCENT:21": "21%",
  "PERCENT:8.5": "8.5%",
  "PERCENT:0": "0%",
  "PERCENT:-3.25": "-3.25%",
  "PERCENT:4.4": "4.4%",
  "PERCENT:44.44": "44.44%",
  "PERCENT:22.2": "22.2%",
  "PERCENT:11.1": "11.1%",
  "PERCENT:9.9": "9.9%",
  "PERCENT:16.6": "16.6%",
  "PERCENT:7.7": "7.7%",
  "MULTIPLE:0.75": "0.75x",
  "MULTIPLE:1": "1.0x",
  "MULTIPLE:-0.4": "-0.4x",
  "MULTIPLE:1.6": "1.6x",
  "MULTIPLE:8.25": "8.25x",
  "MULTIPLE:0.9": "0.9x",
};

function display(value: number, unit: FundamentalMetricUnit): string {
  const text = DISPLAY[`${unit}:${value}`];
  if (text === undefined) {
    throw new Error(`No hand-written display for ${unit} ${value}`);
  }
  return text;
}

function catalogEntry(id: FundamentalMetricId) {
  const entry = FUNDAMENTAL_METRIC_CATALOG.find((metric) => metric.id === id);
  if (!entry) {
    throw new Error(`${id} is not in the catalog`);
  }
  return entry;
}

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..").first();
}

function panel(page: Page): Locator {
  return page.getByTestId("indicators-panel");
}

function fundamentalSelect(page: Page): Locator {
  return panel(page).getByRole("combobox", { name: "Fundamental metric" });
}

async function openStock(
  page: Page,
  viewport: { width: number; height: number } = DESKTOP,
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  await expect(priceChart(page)).toBeVisible();
  await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
}

async function openIndicators(page: Page): Promise<void> {
  if (!(await panel(page).isVisible())) {
    await page.getByTestId("indicators-trigger").click();
  }
  await expect(panel(page)).toBeVisible();
}

async function closeIndicators(page: Page): Promise<void> {
  if (await panel(page).isVisible()) {
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
  }
}

/** Chooses a metric and waits for its line (or its absence) to be the one the chart holds. */
async function chooseFundamental(
  page: Page,
  id: FundamentalMetricId,
): Promise<void> {
  await openIndicators(page);
  await fundamentalSelect(page).selectOption(id);
  await expect(chartWrapper(page)).toHaveAttribute("data-fundamental", id);
  await expect(chartWrapper(page)).toHaveAttribute(
    "data-fundamental-unit",
    catalogEntry(id).unit,
  );
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * The seeded calendar: the first session of week 0, from the chart's newest bar — the Friday of the
 * last seeded week — so it holds whichever day the seed ran.
 */
async function seededCalendar(page: Page) {
  const newest = await chartWrapper(page).getAttribute("data-domain-to");
  expect(newest).not.toBeNull();
  const firstSession = addDays(
    newest!,
    -((QA_FUNDAMENTAL_HISTORY_WEEKS - 1) * 7 + 4),
  );
  const weekOf = (date: string) =>
    Math.floor((Date.parse(date) - Date.parse(firstSession)) / (7 * DAY));
  return {
    newest: newest!,
    firstSession,
    weekOf,
    /** The Monday a seeded week starts on. */
    mondayOf: (week: number) => addDays(firstSession, week * 7),
    /** What the fixture stores for a metric on a session. */
    reading: (id: FundamentalMetricId, date: string) =>
      qaFundamentalValue(id as QaFundamentalMetricId, weekOf(date)),
  };
}

/** Every Monday-Friday session from `from` to `to`: `QATEST1` is seeded with no holidays. */
function sessionsBetween(from: string, to: string): string[] {
  const sessions: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      sessions.push(date);
    }
  }
  return sessions;
}

/**
 * The transitions the fixture implies over the loaded sessions, in the chart's `date=value` form:
 * from the first session with a value to the last, a step wherever the value changes, and an empty
 * value where an unavailable interval starts.
 */
async function expectedSteps(
  page: Page,
  id: FundamentalMetricId,
): Promise<string> {
  const calendar = await seededCalendar(page);
  const loadedFrom = await chartWrapper(page).getAttribute("data-loaded-from");
  const readings = sessionsBetween(loadedFrom!, calendar.newest).map(
    (date) => [date, calendar.reading(id, date)] as const,
  );
  const first = readings.findIndex(([, value]) => value !== undefined);
  let last = readings.length - 1;
  while (last >= 0 && readings[last]![1] === undefined) {
    last -= 1;
  }
  if (first === -1) {
    return "";
  }
  const steps: string[] = [];
  let previous: number | undefined | null = null;
  for (const [date, value] of readings.slice(first, last + 1)) {
    if (value !== previous) {
      steps.push(`${date}=${value ?? ""}`);
      previous = value;
    }
  }
  return steps.join(";");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Aug 28, 2026" -> "2026-08-28": the legend's first row, the hovered session. */
function legendDate(text: string): string {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!match) {
    throw new Error(`Unrecognised legend date '${text}'`);
  }
  const month = String(MONTHS.indexOf(match[1]!) + 1).padStart(2, "0");
  return `${match[3]}-${month}-${match[2]!.padStart(2, "0")}`;
}

/**
 * Sweeps the pointer across the plot and returns, per hovered session, what the legend printed for
 * the chosen metric — or `null` when it printed no row for it.
 */
async function sweepLegend(
  page: Page,
  label: string,
  steps = 90,
): Promise<Map<string, string | null>> {
  // The pointer can only hover what is on screen: on a phone the plot starts below the fold.
  await priceChart(page).scrollIntoViewIfNeeded();
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  const legend = page.getByTestId("chart-legend");
  const seen = new Map<string, string | null>();
  // The right-hand price axis is not plot area; stay inside the plot.
  const left = box!.x + 4;
  const right = box!.x + box!.width - 80;
  for (let step = 0; step <= steps; step += 1) {
    await page.mouse.move(
      left + ((right - left) * step) / steps,
      box!.y + box!.height * 0.25,
    );
    const rows = await legend.evaluate((element: HTMLElement) =>
      element.hidden
        ? null
        : [...element.children].map((child) => [
            child.children[child.children.length - 2]?.textContent ?? "",
            child.querySelector("strong")?.textContent ?? "",
          ]),
    );
    if (!rows || rows.length === 0) {
      continue;
    }
    const date = legendDate(rows[0]![0]!);
    const row = rows.find(([name]) => name === label);
    seen.set(date, row ? row[1]! : null);
  }
  return seen;
}

/** Canvases inside the chart: a duplication-proof fingerprint of how many panes are drawn. */
async function chartCanvasCount(page: Page): Promise<number> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
  return priceChart(page).locator("canvas").count();
}

type FundamentalRequest = { metric: string | null; from: string; to: string };

function watchFundamentalRequests(page: Page): FundamentalRequest[] {
  const requests: FundamentalRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== `/stocks/${QA_SYMBOL}/fundamentals/daily`) {
      return;
    }
    requests.push({
      metric: url.searchParams.get("metric"),
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
    });
  });
  return requests;
}

test.describe("PRO_USER Stock Details fundamental metrics", () => {
  test("charts a chosen metric from its persisted history as a step line, with its gap @smoke", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchFundamentalRequests(page);
    await openStock(page);
    await openIndicators(page);

    // One Fundamentals section after the overlay groups, every catalog metric in it exactly once.
    const legends = panel(page).locator("legend");
    await expect(
      legends.filter({ hasText: FUNDAMENTAL_METRICS_LABEL }),
    ).toHaveCount(1);
    await expect(legends.last()).toHaveText(FUNDAMENTAL_METRICS_LABEL);
    const options = fundamentalSelect(page).locator("option");
    await expect(options).toHaveCount(FUNDAMENTAL_METRIC_CATALOG.length + 1);
    await expect(options.first()).toHaveText("None");
    await expect(
      fundamentalSelect(page).locator("option", { hasText: /^ROIC TTM$/ }),
    ).toHaveCount(1);
    // Nothing is asked for before a metric is chosen.
    expect(requests).toEqual([]);

    await chooseFundamental(page, "ROIC_TTM");
    const wrapper = chartWrapper(page);
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    // The metric's own catalog words explain it where it was chosen.
    await expect(page.getByTestId("fundamental-help")).toContainText(
      catalogEntry("ROIC_TTM").summary,
    );

    // One request, naming the metric by its stable identity, for exactly the loaded window.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.metric).toBe("ROIC_TTM");
    const loadedFrom = await wrapper.getAttribute("data-loaded-from");
    expect(requests[0]!.from <= loadedFrom!).toBe(true);

    // Exactly the fixture's transitions over the loaded year: 12.5% -> 18.25% -> gap -> 21%, as two
    // separately drawn stretches with the unavailable sessions between them.
    const calendar = await seededCalendar(page);
    await expect(wrapper).toHaveAttribute(
      "data-fundamental-steps",
      await expectedSteps(page, "ROIC_TTM"),
    );
    const steps = (await wrapper.getAttribute("data-fundamental-steps"))!;
    expect(steps).toContain(`${calendar.mondayOf(120)}=18.25`);
    expect(steps).toContain(`${calendar.mondayOf(135)}=`);
    expect(steps).toContain(`${calendar.mondayOf(140)}=21`);
    await expect(wrapper).toHaveAttribute("data-fundamental-runs", "2");
    await expect(wrapper).toHaveAttribute("data-fundamental-gaps", "25");

    await expect(page.getByRole("list", { name: "Chart key" })).toContainText(
      "ROIC TTM",
    );
    await expect(page.getByTestId("fundamental-status")).toHaveCount(0);

    // The hover legend reads the session under the pointer: the stored value in its unit inside a
    // stretch, "Unavailable" inside the gap — never a number there, and never the 18.25% before it.
    await closeIndicators(page);
    const seen = await sweepLegend(page, "ROIC TTM");
    const kinds = new Set<string>();
    for (const [date, text] of seen) {
      const value = calendar.reading("ROIC_TTM", date);
      if (date < loadedFrom!) {
        continue;
      }
      if (value === undefined) {
        expect(text, date).toBe("Unavailable");
        kinds.add("gap");
      } else {
        expect(text, date).toBe(display(value, "PERCENT"));
        kinds.add(String(value));
      }
    }
    expect([...kinds].sort()).toEqual(["12.5", "18.25", "21", "gap"]);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("reads percentages and multiples in their own units: 18.25%, 0.75x and 1.0x", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const calendar = await seededCalendar(page);

    await chooseFundamental(page, "DEBT_TO_EQUITY");
    await closeIndicators(page);
    const seen = await sweepLegend(page, "Debt / Equity");
    const texts = new Set<string>();
    for (const [date, text] of seen) {
      const value = calendar.reading("DEBT_TO_EQUITY", date);
      expect(value, date).toBeDefined();
      expect(text, date).toBe(display(value!, "MULTIPLE"));
      texts.add(text!);
    }
    // 0.75 stays 0.75x, never rounded to 0.8x; a whole ratio keeps a decimal.
    expect([...texts].sort()).toEqual(["0.75x", "1.0x"]);
    expect([...seen.values()]).not.toContain("0.8x");

    await chooseFundamental(page, "ROIC_TTM");
    await closeIndicators(page);
    const percent = await sweepLegend(page, "ROIC TTM");
    expect([...percent.values()]).toContain("18.25%");
    expect([...percent.values()].filter((text) => text?.endsWith("x"))).toEqual(
      [],
    );

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("switches ROIC -> Debt / Equity -> Revenue Growth cleanly, and the newest choice wins a race", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchFundamentalRequests(page);
    await openStock(page);
    const baseline = await chartCanvasCount(page);

    await chooseFundamental(page, "ROIC_TTM");
    const withPane = await chartCanvasCount(page);
    expect(withPane).toBeGreaterThan(baseline);

    const sequence: FundamentalMetricId[] = [
      "DEBT_TO_EQUITY",
      "REVENUE_GROWTH_TTM_YOY",
      "ROIC_TTM",
    ];
    for (const id of sequence) {
      await chooseFundamental(page, id);
      const entry = catalogEntry(id);
      // The drawn line is the new metric's own transitions, nothing of the previous one.
      await expect(chartWrapper(page)).toHaveAttribute(
        "data-fundamental-steps",
        await expectedSteps(page, id),
      );
      await expect(page.getByRole("list", { name: "Chart key" })).toContainText(
        entry.label,
      );
      // One pane, replaced — never a second one beside the first.
      expect(await chartCanvasCount(page)).toBe(withPane);
      await closeIndicators(page);
      const last = await sweepLegend(page, entry.label, 12);
      const [date, text] = [...last].at(-1)!;
      const value = (await seededCalendar(page)).reading(id, date);
      expect(text).toBe(display(value!, entry.unit));
    }
    expect(requests.map((request) => request.metric)).toEqual([
      "ROIC_TTM",
      ...sequence,
    ]);

    // A race: ROIC's answer is held back while Debt / Equity is chosen after it. The late ROIC
    // answer must not replace the newer choice.
    await chooseFundamental(page, "NET_MARGIN_TTM");
    await page.route(
      /\/stocks\/QATEST1\/fundamentals\/daily\?.*metric=ROIC_TTM/,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue().catch(() => undefined);
      },
    );
    await openIndicators(page);
    await fundamentalSelect(page).selectOption("ROIC_TTM");
    await fundamentalSelect(page).selectOption("DEBT_TO_EQUITY");
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental",
      "DEBT_TO_EQUITY",
    );
    await page.waitForTimeout(2_000);
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental",
      "DEBT_TO_EQUITY",
    );
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-steps",
      await expectedSteps(page, "DEBT_TO_EQUITY"),
    );
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // None removes the pane and restores the chart without it.
    await fundamentalSelect(page).selectOption("");
    await expect(chartWrapper(page)).not.toHaveAttribute("data-fundamental");
    await expect.poll(() => chartCanvasCount(page)).toBe(baseline);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("draws a real zero and negative readings, and says when a metric has nothing to draw", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const calendar = await seededCalendar(page);

    await chooseFundamental(page, "REVENUE_GROWTH_TTM_YOY");
    const steps = await chartWrapper(page).getAttribute(
      "data-fundamental-steps",
    );
    // A zero is a value on the line, not a gap, and so is the negative growth after it.
    expect(steps).toContain(`${calendar.mondayOf(125)}=0`);
    expect(steps).toContain(`${calendar.mondayOf(145)}=-3.25`);
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-gaps",
      "0",
    );
    await closeIndicators(page);
    const growth = await sweepLegend(page, "Revenue Growth TTM YoY", 40);
    expect([...growth.values()]).toContain("0%");
    expect([...growth.values()]).toContain("-3.25%");

    await chooseFundamental(page, "NET_DEBT_TO_EBITDA_TTM");
    await closeIndicators(page);
    const netDebt = await sweepLegend(page, "Net Debt / EBITDA TTM", 12);
    expect(new Set(netDebt.values())).toEqual(new Set(["-0.4x"]));

    // Unavailable on every session: said in words, with no pane, no line and no zero.
    await chooseFundamental(page, "EPS_GROWTH_TTM_YOY");
    await expect(page.getByTestId("fundamental-status")).toHaveText(
      "EPS Growth TTM YoY is unavailable for every session in the loaded history.",
    );
    await expect(chartWrapper(page)).not.toHaveAttribute(
      "data-fundamental-pane",
    );
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-runs",
      "0",
    );
    await closeIndicators(page);
    const none = await sweepLegend(page, "EPS Growth TTM YoY", 12);
    expect(new Set(none.values())).toEqual(new Set(["Unavailable"]));

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("follows older history back to the metric's first eligible session, asking only for the gap", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchFundamentalRequests(page);
    await openStock(page);
    await chooseFundamental(page, "ROIC_TTM");
    const firstRequest = requests[0]!;
    await closeIndicators(page);

    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("MAX", { exact: true })
      .click();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-history-exhausted",
      "true",
    );
    const calendar = await seededCalendar(page);
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-loaded-from",
      calendar.firstSession,
    );

    // The line now starts on the first eligible session — week 40's Monday — and nothing before it.
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-steps",
      new RegExp(`^${calendar.mondayOf(40)}=12\\.5;`),
    );
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-steps",
      await expectedSteps(page, "ROIC_TTM"),
    );
    // The older interval alone was asked for — back to the boundary the API reports, which for
    // this fixture is its first seeded session — ending the day before what was already held.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      metric: "ROIC_TTM",
      from: calendar.firstSession,
      to: addDays(firstRequest.from, -1),
    });

    // Zooming with the pane present still moves the shared time scale.
    const before = await chartWrapper(page).getAttribute("data-visible-range");
    const box = await priceChart(page).boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 3);
    await page.mouse.wheel(0, -600);
    await expect
      .poll(() => chartWrapper(page).getAttribute("data-visible-range"))
      .not.toBe(before);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("charts all fifteen metrics one after another, each in its own unit and from its own column", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const calendar = await seededCalendar(page);
    let paneCanvases: number | null = null;

    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      await chooseFundamental(page, entry.id);
      await expect(chartWrapper(page)).toHaveAttribute(
        "data-fundamental-steps",
        await expectedSteps(page, entry.id),
      );
      const latest = calendar.reading(entry.id, calendar.newest);
      await closeIndicators(page);
      const seen = await sweepLegend(page, entry.label, 6);
      const [, text] = [...seen].at(-1)!;
      expect(text, entry.id).toBe(
        latest === undefined ? "Unavailable" : display(latest, entry.unit),
      );
      if (latest !== undefined) {
        const canvases = await chartCanvasCount(page);
        paneCanvases ??= canvases;
        // Fifteen metrics later, still exactly one Fundamental Metric pane.
        expect(canvases, entry.id).toBe(paneCanvases);
      }
    }

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("stays usable on a phone viewport", async ({ page }) => {
    const issues = watchForIssues(page);
    await openStock(page, MOBILE);
    await openIndicators(page);

    // The popover and its select stay inside the screen.
    const panelBox = await panel(page).boundingBox();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(MOBILE.width);
    await fundamentalSelect(page).scrollIntoViewIfNeeded();
    const selectBox = await fundamentalSelect(page).boundingBox();
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(MOBILE.width);

    await chooseFundamental(page, "NET_DEBT_TO_EBITDA_TTM");
    await closeIndicators(page);
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-pane",
      "true",
    );

    // The price chart keeps a useful height above the new pane, and nothing overflows. The price
    // pane is the chart's first row: the wrapper grows by the new pane, so it is not squeezed.
    const chartBox = await priceChart(page).boundingBox();
    expect(chartBox!.height).toBeGreaterThanOrEqual(420);
    const pricePane = await priceChart(page)
      .locator("tr")
      .first()
      .boundingBox();
    expect(pricePane!.height).toBeGreaterThanOrEqual(250);
    expect(chartBox!.x + chartBox!.width).toBeLessThanOrEqual(MOBILE.width);
    const key = page.getByRole("list", { name: "Chart key" });
    await expect(key).toContainText("Net Debt / EBITDA TTM");
    const keyBox = await key.boundingBox();
    expect(keyBox!.x + keyBox!.width).toBeLessThanOrEqual(MOBILE.width);
    const seen = await sweepLegend(page, "Net Debt / EBITDA TTM", 10);
    expect(new Set(seen.values())).toEqual(new Set(["-0.4x"]));
    const legendBox = await page.getByTestId("chart-legend").boundingBox();
    expect(legendBox!.x + legendBox!.width).toBeLessThanOrEqual(MOBILE.width);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(MOBILE.width);
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("keeps volume, RSI and the fundamental in one pane order, whichever is chosen first", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const wrapper = chartWrapper(page);
    const rsi = panel(page).getByRole("checkbox", {
      name: "RSI 14D",
      exact: true,
    });
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");

    // Fundamental first. The RSI's pane is then created below it and has to be swapped above it
    // in the same frame, before the library has drawn the pane it just created.
    await chooseFundamental(page, "ROIC_TTM");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,fundamental",
    );
    await rsi.check();
    await expect(wrapper).toHaveAttribute("data-oscillator-pane", "true");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );
    // Another metric with the RSI on keeps the order; the RSI leaving lifts the fundamental up.
    await chooseFundamental(page, "DEBT_TO_EQUITY");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );
    await rsi.uncheck();
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,fundamental",
    );

    // RSI first: the fundamental's pane is appended below it, already in order.
    await fundamentalSelect(page).selectOption("");
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");
    await rsi.check();
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator",
    );
    await chooseFundamental(page, "NET_DEBT_TO_EBITDA_TTM");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );

    // Both read on one crosshair: the RSI and the fundamental, each in its own terms.
    await closeIndicators(page);
    const seen = await sweepLegend(page, "Net Debt / EBITDA TTM", 6);
    expect(new Set(seen.values())).toEqual(new Set(["-0.4x"]));
    await expect(page.getByTestId("chart-legend")).toContainText("RSI 14D");

    // Both panes created within one task, fundamental first — before the library has rendered
    // either, since it only renders on an animation frame between tasks. The metric's rows are
    // still held, so choosing it again draws its pane in that same commit, and the RSI's pane
    // follows in the next one; the swap that orders them must not depend on panes the library has
    // not rendered yet.
    await openIndicators(page);
    await rsi.uncheck();
    await fundamentalSelect(page).selectOption("");
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(null)),
          ),
        ),
    );
    const fundamentalRequests = watchFundamentalRequests(page);
    const orderBetween = await page.evaluate(async () => {
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="fundamental-select"]',
      )!;
      const chartWrapper = document.querySelector<HTMLElement>(
        '[role="img"][aria-label*="daily closing price chart"]',
      )!.parentElement!;
      select.value = "NET_DEBT_TO_EBITDA_TTM";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      // Microtasks only — no timer, so no frame can be rendered in between. React commits a
      // discrete update, effects included, in a microtask; wait for the fundamental's pane to be
      // in the chart's model, and fail loudly rather than test something else if it is not.
      for (
        let hop = 0;
        hop < 50 &&
        chartWrapper.dataset.paneOrder !== "price,volume,fundamental";
        hop += 1
      ) {
        await Promise.resolve();
      }
      const between = chartWrapper.dataset.paneOrder;
      const checkbox = [
        ...document.querySelectorAll<HTMLInputElement>(
          '[data-testid="indicators-panel"] input[type="checkbox"]',
        ),
      ].find((input) => input.labels?.[0]?.textContent?.trim() === "RSI 14D")!;
      checkbox.click();
      return between;
    });
    expect(orderBetween).toBe("price,volume,fundamental");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );
    await expect(wrapper).toHaveAttribute(
      "data-fundamental",
      "NET_DEBT_TO_EBITDA_TTM",
    );
    await expect(rsi).toBeChecked();
    // Drawn from the rows already held: nothing was asked for again.
    expect(fundamentalRequests).toEqual([]);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("holds the pane's place while the next metric loads: neither the page nor the price pane moves", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const wrapper = chartWrapper(page);
    const pricePane = priceChart(page).locator("tr").first();
    const settle = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(null)),
            ),
          ),
      );
    const heights = async () => {
      await settle();
      return {
        wrapper: (await wrapper.boundingBox())!.height,
        price: (await pricePane.boundingBox())!.height,
      };
    };

    await chooseFundamental(page, "DEBT_TO_EQUITY");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    const drawn = await heights();

    // The next metric's answer is held back: the wait is a wait, the old line is gone, and an
    // empty pane keeps its place.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      /\/stocks\/QATEST1\/fundamentals\/daily\?.*metric=ROIC_TTM/,
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await fundamentalSelect(page).selectOption("ROIC_TTM");
    await expect(page.getByTestId("fundamental-status")).toHaveText(
      "Loading ROIC TTM…",
    );
    await expect(wrapper).not.toHaveAttribute("data-fundamental-pane");
    await expect(wrapper).toHaveAttribute("data-fundamental-space", "true");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,fundamental",
    );
    const waiting = await heights();
    expect(waiting.wrapper).toBe(drawn.wrapper);
    expect(Math.abs(waiting.price - drawn.price)).toBeLessThanOrEqual(1);

    release();
    await expect(wrapper).toHaveAttribute("data-fundamental", "ROIC_TTM");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await expect(page.getByTestId("fundamental-status")).toHaveCount(0);
    const arrived = await heights();
    expect(arrived.wrapper).toBe(drawn.wrapper);
    expect(Math.abs(arrived.price - drawn.price)).toBeLessThanOrEqual(1);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("says it is loading while it is, reports a failure as a failure, and retries it", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);

    // Held back: the wait is announced as a wait, never as "unavailable".
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      /\/stocks\/QATEST1\/fundamentals\/daily\?.*metric=ROIC_TTM/,
      async (route) => {
        await held;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            statusCode: 503,
            message: "Stock data is temporarily unavailable",
          }),
        });
      },
    );
    await openIndicators(page);
    await fundamentalSelect(page).selectOption("ROIC_TTM");
    await expect(page.getByTestId("fundamental-status")).toHaveText(
      "Loading ROIC TTM…",
    );
    await expect(
      page.getByText(/is unavailable for every session/),
    ).toHaveCount(0);

    release();
    const alert = page.getByRole("alert").filter({ hasText: "ROIC TTM" });
    await expect(alert).toContainText("ROIC TTM could not be loaded.");
    // A failure is not the metric being unavailable, and nothing is drawn for it.
    await expect(
      page.getByText(/is unavailable for every session/),
    ).toHaveCount(0);
    await expect(chartWrapper(page)).not.toHaveAttribute(
      "data-fundamental-pane",
    );

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closeIndicators(page);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental-pane",
      "true",
    );
    await expect(alert).toHaveCount(0);

    // The one failure this test caused, and nothing else.
    expect(issues.failedRequests).toHaveLength(1);
    expect(issues.failedRequests[0]).toMatch(/^503 .*metric=ROIC_TTM/);
    expect(
      issues.consoleErrors.filter((message) => !/503/.test(message)),
    ).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  });

  test("starts from no fundamental after a reload, as the overlays start from their defaults", async ({
    page,
  }) => {
    await openStock(page);
    await chooseFundamental(page, "ROIC_TTM");
    await page.reload();
    await expect(priceChart(page)).toBeVisible();
    await expect(chartWrapper(page)).not.toHaveAttribute("data-fundamental");
    await openIndicators(page);
    await expect(fundamentalSelect(page)).toHaveValue("");
  });
});
