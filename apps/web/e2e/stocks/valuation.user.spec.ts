import {
  FUNDAMENTAL_METRICS_LABEL,
  VALUATION_RATIO_CATALOG,
  VALUATION_RATIOS_LABEL,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import {
  QA_VALUATION_HISTORY_WEEKS,
  QA_VALUATION_NET_CASH,
  QA_VALUATION_WITHHELD,
  qaValuationAvailable,
} from "@intrinsic/testing/qa-valuation";
import { expect, test, type Locator, type Page } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * Stock Details valuation ratios for PRO_USER, through the real Next + Nest + PostgreSQL + Redis
 * stack.
 *
 * Nothing about a ratio is stored per session: the API computes each one when it is read, with the
 * calculation a Strategy Condition reads, from what `pnpm test:securities:seed` stores for
 * `QATEST1` — the filings, the verified price basis and the measured re-base of
 * `QA_VALUATION_QUARTERS` in `@intrinsic/testing`. Where each ratio is available is written out by
 * hand in that module (`QA_VALUATION_AVAILABILITY`), and every expectation about it below is derived
 * from that table and the seeded calendar — and compared with the API's own answer, so the line
 * breaks exactly where the server has no value and nowhere else.
 *
 * Lines live on a canvas, so the chart's DOM contract is what is asserted — `data-valuation*`,
 * including where each drawn stretch starts and ends and the line type the library holds — together
 * with the hover legend and the network request each choice causes.
 */

const QA_SYMBOL = "QATEST1";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const DAY = 86_400_000;
const VALUATION_PATH = `/stocks/${QA_SYMBOL}/valuation-ratios/daily`;

type Row = { date: string; value?: number };

function catalogEntry(id: ValuationRatioId) {
  const entry = VALUATION_RATIO_CATALOG.find((ratio) => ratio.id === id);
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

function valuationSelect(page: Page): Locator {
  return panel(page).getByRole("combobox", { name: "Valuation ratio" });
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

/** Chooses a ratio and waits until the chart holds it. */
async function chooseValuation(
  page: Page,
  id: ValuationRatioId,
): Promise<void> {
  await openIndicators(page);
  await valuationSelect(page).selectOption(id);
  await expect(chartWrapper(page)).toHaveAttribute("data-valuation", id);
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
    -((QA_VALUATION_HISTORY_WEEKS - 1) * 7 + 4),
  );
  return {
    newest: newest!,
    firstSession,
    weekOf: (date: string) =>
      Math.floor((Date.parse(date) - Date.parse(firstSession)) / (7 * DAY)),
    /** The Monday a seeded week starts on. */
    mondayOf: (week: number) => addDays(firstSession, week * 7),
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

/** `from..to` per stretch of consecutive available sessions: the chart's `data-valuation-stretches`. */
function stretchesOf(
  sessions: readonly { date: string; available: boolean }[],
) {
  const stretches: string[] = [];
  let start: string | null = null;
  let previous: string | null = null;
  for (const session of sessions) {
    if (session.available) {
      start ??= session.date;
      previous = session.date;
    } else if (start !== null) {
      stretches.push(`${start}..${previous}`);
      start = null;
    }
  }
  if (start !== null) {
    stretches.push(`${start}..${previous}`);
  }
  return stretches.join(";");
}

/** The stretches the fixture table implies over the sessions the chart holds. */
async function expectedStretches(
  page: Page,
  id: ValuationRatioId,
): Promise<string> {
  const calendar = await seededCalendar(page);
  const loadedFrom = await chartWrapper(page).getAttribute("data-loaded-from");
  return stretchesOf(
    sessionsBetween(loadedFrom!, calendar.newest).map((date) => ({
      date,
      available: qaValuationAvailable(id, calendar.weekOf(date)),
    })),
  );
}

/** The stretches the server's own answer implies: where it returned a value and where it did not. */
function serverStretches(rows: readonly Row[]): string {
  return stretchesOf(
    rows.map((row) => ({ date: row.date, available: row.value !== undefined })),
  );
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
 * the chosen series — or `null` when it printed no row for it.
 */
async function sweepLegend(
  page: Page,
  label: string,
  steps = 90,
): Promise<Map<string, string | null>> {
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

/** `"1,234.5x"` -> 1234.5: what a multiple the legend printed reads as. */
function multipleValue(text: string): number {
  expect(text).toMatch(/^-?\d{1,3}(,\d{3})*(\.\d{1,2})?x$/);
  return Number(text.slice(0, -1).replaceAll(",", ""));
}

/** Canvases inside the chart: a duplication-proof fingerprint of how many panes are drawn. */
async function chartCanvasCount(page: Page): Promise<number> {
  await settle(page);
  return priceChart(page).locator("canvas").count();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}

type ValuationRequest = { ratio: string[]; from: string; to: string };

function watchValuationRequests(page: Page): ValuationRequest[] {
  const requests: ValuationRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== VALUATION_PATH) {
      return;
    }
    requests.push({
      ratio: url.searchParams.getAll("ratio"),
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
    });
  });
  return requests;
}

function isValuationRequest(ratio: ValuationRatioId) {
  return new RegExp(
    `/stocks/${QA_SYMBOL}/valuation-ratios/daily\\?.*ratio=${ratio}`,
  );
}

test.describe("PRO_USER Stock Details valuation ratios", () => {
  test("offers a Valuation section with the five catalog ratios, and asks for nothing until one is chosen @smoke", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchValuationRequests(page);
    await openStock(page);
    await openIndicators(page);

    // One Valuation section, right before Fundamentals, after every overlay group.
    const legends = panel(page).locator("legend");
    await expect(
      legends.filter({ hasText: VALUATION_RATIOS_LABEL }),
    ).toHaveCount(1);
    expect((await legends.allTextContents()).slice(-2)).toEqual([
      VALUATION_RATIOS_LABEL,
      FUNDAMENTAL_METRICS_LABEL,
    ]);
    // Written out by hand, so a sixth catalog ratio is a deliberate change here too; the values are
    // the catalog's identities and never labels.
    const options = valuationSelect(page).locator("option");
    await expect(options).toHaveText([
      "None",
      "P/E",
      "P/S",
      "P/B",
      "P/FCF",
      "EV/EBITDA",
    ]);
    expect(
      await options.evaluateAll((elements) =>
        elements.map((element) => (element as HTMLOptionElement).value),
      ),
    ).toEqual(["", ...VALUATION_RATIO_CATALOG.map((entry) => entry.id)]);
    await expect(valuationSelect(page)).toHaveValue("");
    await expect(page.getByTestId("valuation-help")).toHaveCount(0);

    expect(requests).toEqual([]);
    await expect(chartWrapper(page)).not.toHaveAttribute("data-valuation");
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-pane-order",
      "price,volume",
    );

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("charts P/E from the server's own answer: an ordinary line in its own pane, broken exactly where the server has no value", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchValuationRequests(page);
    await openStock(page);
    const answer = page.waitForResponse(
      (response) => new URL(response.url()).pathname === VALUATION_PATH,
    );
    await chooseValuation(page, "PRICE_TO_EARNINGS_TTM");
    const rows = (await (await answer).json()) as Row[];
    const wrapper = chartWrapper(page);
    const calendar = await seededCalendar(page);

    // Its own pane below price and volume, never on either scale, drawn as an ordinary line — the
    // type the library itself holds — and never as a step.
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    await expect(wrapper).toHaveAttribute("data-valuation-line", "simple");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,valuation",
    );

    // One request: the ratio by its identity alone, over exactly the history the chart holds — the
    // loaded year up to the newest bar, never the security's thirty years.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.ratio).toEqual(["PRICE_TO_EARNINGS_TTM"]);
    expect(requests[0]?.to).toBe(calendar.newest);
    const loadedFrom = await wrapper.getAttribute("data-loaded-from");
    expect(requests[0]!.from <= loadedFrom!).toBe(true);
    expect(requests[0]!.from > calendar.firstSession).toBe(true);
    // Every loaded session has a row, and nothing else does.
    expect(rows.map((row) => row.date)).toEqual(
      sessionsBetween(loadedFrom!, calendar.newest),
    );

    // The server's absence is the fixture's, and the chart breaks the line exactly there: available
    // up to the Friday before the measured re-base, nothing for weeks 130-148, again from the Monday
    // of week 149.
    const expected = await expectedStretches(page, "PRICE_TO_EARNINGS_TTM");
    expect(serverStretches(rows)).toBe(expected);
    await expect(wrapper).toHaveAttribute("data-valuation-stretches", expected);
    expect(expected).toContain(
      `..${addDays(calendar.mondayOf(QA_VALUATION_WITHHELD.fromWeek), -3)};${calendar.mondayOf(QA_VALUATION_WITHHELD.untilWeek)}..`,
    );
    await expect(wrapper).toHaveAttribute("data-valuation-runs", "2");
    await expect(wrapper).toHaveAttribute(
      "data-valuation-gaps",
      String(rows.filter((row) => row.value === undefined).length),
    );

    // The catalog's own words explain it, the key names it, and nothing reports it as missing.
    const entry = catalogEntry("PRICE_TO_EARNINGS_TTM");
    await expect(page.getByTestId("valuation-help")).toHaveText(
      `${entry.summary}${entry.formula}`,
    );
    await expect(page.getByRole("list", { name: "Chart key" })).toContainText(
      "P/E",
    );
    await expect(page.getByTestId("valuation-status")).toHaveCount(0);

    // The hover legend reads the session under the pointer: the server's value as a raw multiple
    // inside a stretch, "Unavailable" inside the gap — never a number there and never the reading
    // before it.
    await closeIndicators(page);
    const byDate = new Map(rows.map((row) => [row.date, row.value]));
    const seen = await sweepLegend(page, "P/E");
    const kinds = new Set<string>();
    for (const [date, text] of seen) {
      expect(byDate.has(date), date).toBe(true);
      const value = byDate.get(date);
      if (value === undefined) {
        expect(text, date).toBe("Unavailable");
        kinds.add("gap");
      } else {
        expect(
          Math.abs(multipleValue(text!) - value),
          date,
        ).toBeLessThanOrEqual(0.0051);
        kinds.add("value");
      }
    }
    expect([...kinds].sort()).toEqual(["gap", "value"]);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("prints every reading as a raw multiple: 0.75x, 1.0x, 15.0x, 15.2x and -1.25x, never 0.8x", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    // Designed readings on every session, served in place of the computed ones: this is about how
    // the page prints a multiple, which the server's own values cannot pin to exact literals.
    const designed = [0.75, 1, 15, 15.2, -1.25];
    await page.route(isValuationRequest("EV_TO_EBITDA_TTM"), async (route) => {
      const url = new URL(route.request().url());
      const rows = sessionsBetween(
        url.searchParams.get("from")!,
        url.searchParams.get("to")!,
      ).map((date, index) => ({
        date,
        value: designed[index % designed.length],
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });
    await openStock(page);
    await chooseValuation(page, "EV_TO_EBITDA_TTM");
    await closeIndicators(page);

    const texts = new Set((await sweepLegend(page, "EV/EBITDA", 200)).values());
    for (const text of ["0.75x", "1.0x", "15.0x", "15.2x", "-1.25x"]) {
      expect(texts, text).toContain(text);
    }
    expect(texts).not.toContain("0.8x");
    for (const text of texts) {
      expect(text).not.toMatch(/[$%e]/);
    }

    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("replaces P/E with P/B in the one pane, and lets the newest choice win a race", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchValuationRequests(page);
    await openStock(page);
    const wrapper = chartWrapper(page);
    const baseline = await chartCanvasCount(page);

    await chooseValuation(page, "PRICE_TO_EARNINGS_TTM");
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    const withPane = await chartCanvasCount(page);
    expect(withPane).toBeGreaterThan(baseline);

    for (const id of [
      "PRICE_TO_BOOK",
      "PRICE_TO_SALES_TTM",
      "EV_TO_EBITDA_TTM",
    ] as const) {
      await chooseValuation(page, id);
      await expect(wrapper).toHaveAttribute(
        "data-valuation-stretches",
        await expectedStretches(page, id),
      );
      // Replaced, never a second valuation pane beside the first.
      expect(await chartCanvasCount(page)).toBe(withPane);
      await expect(wrapper).toHaveAttribute(
        "data-pane-order",
        "price,volume,valuation",
      );
      await expect(page.getByRole("list", { name: "Chart key" })).toContainText(
        catalogEntry(id).label,
      );
    }
    // One request per choice, each for the chosen ratio alone.
    expect(requests.map((request) => request.ratio)).toEqual([
      ["PRICE_TO_EARNINGS_TTM"],
      ["PRICE_TO_BOOK"],
      ["PRICE_TO_SALES_TTM"],
      ["EV_TO_EBITDA_TTM"],
    ]);

    // A race: P/E's answer is held back until P/B, chosen after it, is on screen. The late P/E
    // answer must not replace the newer choice.
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = (): void => {};
    const peHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    let delivered = (): void => {};
    const peDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    await page.route(
      isValuationRequest("PRICE_TO_EARNINGS_TTM"),
      async (route) => {
        held();
        await released;
        // The page has already given up on the request it superseded, so delivering the answer
        // may be refused; either way the late answer has had its chance.
        await route.continue().catch(() => undefined);
        delivered();
      },
    );
    await openIndicators(page);
    await valuationSelect(page).selectOption("PRICE_TO_EARNINGS_TTM");
    // P/E is in flight, held, when P/B is chosen.
    await peHeld;
    await valuationSelect(page).selectOption("PRICE_TO_BOOK");
    await expect(wrapper).toHaveAttribute("data-valuation", "PRICE_TO_BOOK");
    await expect(wrapper).toHaveAttribute(
      "data-valuation-stretches",
      await expectedStretches(page, "PRICE_TO_BOOK"),
    );
    release();
    await peDelivered;
    // Whatever the late answer could still do to the page has had two frames to do it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(wrapper).toHaveAttribute("data-valuation", "PRICE_TO_BOOK");
    await expect(wrapper).toHaveAttribute(
      "data-valuation-stretches",
      await expectedStretches(page, "PRICE_TO_BOOK"),
    );
    const key = page.getByRole("list", { name: "Chart key" });
    await expect(key).toContainText("P/B");
    await expect(key).not.toContainText("P/E");
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // None removes the pane and restores the chart without it.
    await valuationSelect(page).selectOption("");
    await expect(wrapper).not.toHaveAttribute("data-valuation");
    await expect.poll(() => chartCanvasCount(page)).toBe(baseline);
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("draws a negative EV/EBITDA as a reading while net cash exceeds the market capitalisation", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    await chooseValuation(page, "EV_TO_EBITDA_TTM");
    const calendar = await seededCalendar(page);
    await closeIndicators(page);

    const seen = await sweepLegend(page, "EV/EBITDA", 150);
    const signs = { negative: 0, positive: 0, unavailable: 0 };
    for (const [date, text] of seen) {
      const week = calendar.weekOf(date);
      if (!qaValuationAvailable("EV_TO_EBITDA_TTM", week)) {
        expect(text, date).toBe("Unavailable");
        signs.unavailable += 1;
        continue;
      }
      const netCash =
        week >= QA_VALUATION_NET_CASH.fromWeek &&
        week < QA_VALUATION_NET_CASH.untilWeek;
      // A negative multiple keeps its sign: never dropped, never shown as unavailable.
      expect(multipleValue(text!) < 0, `${date} ${text}`).toBe(netCash);
      signs[netCash ? "negative" : "positive"] += 1;
    }
    expect(signs.negative).toBeGreaterThan(0);
    expect(signs.positive).toBeGreaterThan(0);
    expect(signs.unavailable).toBeGreaterThan(0);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("says P/FCF is unavailable for every loaded session instead of drawing an empty pane", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    await chooseValuation(page, "PRICE_TO_FCF_TTM");
    const wrapper = chartWrapper(page);

    await expect(page.getByTestId("valuation-status")).toHaveText(
      "P/FCF is unavailable for every session in the loaded history.",
    );
    await expect(wrapper).not.toHaveAttribute("data-valuation-pane");
    await expect(wrapper).not.toHaveAttribute("data-valuation-space");
    await expect(wrapper).toHaveAttribute("data-valuation-runs", "0");
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");
    await expect(
      page.getByRole("list", { name: "Chart key" }),
    ).not.toContainText("P/FCF");
    // Not a failure: nothing is reported as one.
    await expect(
      page.getByRole("alert").filter({ hasText: "could not be loaded" }),
    ).toHaveCount(0);

    await closeIndicators(page);
    const seen = await sweepLegend(page, "P/FCF", 12);
    expect(new Set(seen.values())).toEqual(new Set(["Unavailable"]));

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("says it is loading while it is, reports a failure as a failure, and retries it", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const wrapper = chartWrapper(page);

    // Held back: the wait is announced as a wait, never as "unavailable", and an empty pane holds
    // the ratio's place.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      isValuationRequest("PRICE_TO_EARNINGS_TTM"),
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
    await valuationSelect(page).selectOption("PRICE_TO_EARNINGS_TTM");
    await expect(page.getByTestId("valuation-status")).toHaveText(
      "Loading P/E…",
    );
    await expect(wrapper).toHaveAttribute("data-valuation-space", "true");
    await expect(wrapper).not.toHaveAttribute("data-valuation-pane");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,valuation",
    );
    await expect(
      page.getByText(/is unavailable for every session/),
    ).toHaveCount(0);

    release();
    const alert = page.getByRole("alert").filter({ hasText: "P/E" });
    await expect(alert).toContainText("P/E could not be loaded.");
    // A failure is not the ratio being unavailable, and nothing is drawn for it.
    await expect(
      page.getByText(/is unavailable for every session/),
    ).toHaveCount(0);
    await expect(wrapper).not.toHaveAttribute("data-valuation-pane");
    await expect(wrapper).not.toHaveAttribute("data-valuation-space");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closeIndicators(page);
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    await expect(alert).toHaveCount(0);
    await expect(wrapper).toHaveAttribute(
      "data-valuation-stretches",
      await expectedStretches(page, "PRICE_TO_EARNINGS_TTM"),
    );

    // The one failure this test caused, and nothing else.
    expect(issues.failedRequests).toHaveLength(1);
    expect(issues.failedRequests[0]).toMatch(
      /^503 .*ratio=PRICE_TO_EARNINGS_TTM/,
    );
    expect(
      issues.consoleErrors.filter((message) => !/503/.test(message)),
    ).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  });

  test("keeps volume, RSI, valuation and fundamental in one pane order, whichever is chosen first", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await openStock(page);
    const wrapper = chartWrapper(page);
    const rsi = panel(page).getByRole("checkbox", {
      name: "RSI 14D",
      exact: true,
    });
    const FULL = "price,volume,oscillator,valuation,fundamental";

    // Fundamental first, then the RSI, then the ratio: each new pane arrives at the bottom and is
    // swapped into its place.
    await openIndicators(page);
    await fundamentalSelect(page).selectOption("ROIC_TTM");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await rsi.check();
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );
    await chooseValuation(page, "PRICE_TO_EARNINGS_TTM");
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    await expect(wrapper).toHaveAttribute("data-pane-order", FULL);

    // Both read on one crosshair, each in its own unit, with the RSI beside them.
    await closeIndicators(page);
    const legend = page.getByTestId("chart-legend");
    const valuation = await sweepLegend(page, "P/E", 10);
    expect([...valuation.values()].some((text) => text?.endsWith("x"))).toBe(
      true,
    );
    await expect(legend).toContainText("ROIC TTM");
    await expect(legend).toContainText("RSI 14D");

    // None on the ratio removes its pane and nothing else.
    await openIndicators(page);
    await valuationSelect(page).selectOption("");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,fundamental",
    );
    await expect(wrapper).toHaveAttribute("data-fundamental", "ROIC_TTM");
    await expect(fundamentalSelect(page)).toHaveValue("ROIC_TTM");
    await expect(rsi).toBeChecked();

    // And the other way round: the ratio first, then the RSI, then the fundamental.
    await fundamentalSelect(page).selectOption("");
    await rsi.uncheck();
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");
    await chooseValuation(page, "EV_TO_EBITDA_TTM");
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    await rsi.check();
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,valuation",
    );
    await fundamentalSelect(page).selectOption("DEBT_TO_EQUITY");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await expect(wrapper).toHaveAttribute("data-pane-order", FULL);

    // None on the fundamental removes only the fundamental's pane.
    await fundamentalSelect(page).selectOption("");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,valuation",
    );
    await expect(wrapper).toHaveAttribute("data-valuation", "EV_TO_EBITDA_TTM");

    // Two panes created within one task — the ratio's from rows already held, then the RSI's —
    // before the library has rendered either. The swap that orders them must not depend on panes
    // the library has not drawn yet.
    await rsi.uncheck();
    await valuationSelect(page).selectOption("");
    await expect(wrapper).toHaveAttribute("data-pane-order", "price,volume");
    await settle(page);
    const requests = watchValuationRequests(page);
    const orderBetween = await page.evaluate(async () => {
      const select = document.querySelector<HTMLSelectElement>(
        '[data-testid="valuation-select"]',
      )!;
      const wrapperElement = document.querySelector<HTMLElement>(
        '[role="img"][aria-label*="daily closing price chart"]',
      )!.parentElement!;
      select.value = "EV_TO_EBITDA_TTM";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      // Microtasks only — no timer, so no frame can be rendered in between.
      for (
        let hop = 0;
        hop < 50 &&
        wrapperElement.dataset.paneOrder !== "price,volume,valuation";
        hop += 1
      ) {
        await Promise.resolve();
      }
      const between = wrapperElement.dataset.paneOrder;
      const checkbox = [
        ...document.querySelectorAll<HTMLInputElement>(
          '[data-testid="indicators-panel"] input[type="checkbox"]',
        ),
      ].find((input) => input.labels?.[0]?.textContent?.trim() === "RSI 14D")!;
      checkbox.click();
      return between;
    });
    expect(orderBetween).toBe("price,volume,valuation");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,oscillator,valuation",
    );
    await expect(rsi).toBeChecked();
    // Drawn from the rows already held: nothing was asked for again.
    expect(requests).toEqual([]);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("follows older history with the ratio's gap alone, and never moves the viewport for it", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const requests = watchValuationRequests(page);
    await openStock(page);
    await chooseValuation(page, "PRICE_TO_EARNINGS_TTM");
    const first = requests[0]!;
    await closeIndicators(page);
    const wrapper = chartWrapper(page);

    // The ratio's older gap is held back until the price history it follows has arrived and the
    // chart has framed it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      isValuationRequest("PRICE_TO_EARNINGS_TTM"),
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("MAX", { exact: true })
      .click();
    await expect(wrapper).toHaveAttribute("data-history-exhausted", "true");
    const calendar = await seededCalendar(page);
    await expect(wrapper).toHaveAttribute(
      "data-loaded-from",
      calendar.firstSession,
    );
    await expect.poll(() => requests.length).toBe(2);
    await expect(wrapper).toHaveAttribute("data-loading", "false");
    await settle(page);
    const framed = await wrapper.getAttribute("data-visible-range");

    release();
    // The line now reaches back to the ratio's first complete trailing year — the Monday of week
    // 45 — and keeps the stretches it already had.
    await expect(wrapper).toHaveAttribute(
      "data-valuation-stretches",
      await expectedStretches(page, "PRICE_TO_EARNINGS_TTM"),
    );
    await expect(wrapper).toHaveAttribute(
      "data-valuation-stretches",
      new RegExp(`^${calendar.mondayOf(45)}\\.\\.`),
    );
    await settle(page);
    // Arriving history never moved the window the user was looking at.
    expect(await wrapper.getAttribute("data-visible-range")).toBe(framed);
    // The older interval alone was asked for: back to the boundary the API reports, ending the day
    // before what was already held — nothing held was asked for again.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      ratio: ["PRICE_TO_EARNINGS_TTM"],
      from: calendar.firstSession,
      to: addDays(first.from, -1),
    });

    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("stays usable on a phone viewport", async ({ page }) => {
    const issues = watchForIssues(page);
    await openStock(page, MOBILE);
    await openIndicators(page);

    // The popover, the select and the chosen ratio's explanation stay inside the screen.
    const panelBox = await panel(page).boundingBox();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(MOBILE.width);
    await chooseValuation(page, "EV_TO_EBITDA_TTM");
    await valuationSelect(page).scrollIntoViewIfNeeded();
    const selectBox = await valuationSelect(page).boundingBox();
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(MOBILE.width);
    const help = page.getByTestId("valuation-help");
    await help.scrollIntoViewIfNeeded();
    const helpBox = await help.boundingBox();
    expect(helpBox!.x).toBeGreaterThanOrEqual(0);
    expect(helpBox!.x + helpBox!.width).toBeLessThanOrEqual(MOBILE.width);
    expect(
      await help.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);

    await fundamentalSelect(page).selectOption("NET_DEBT_TO_EBITDA_TTM");
    await closeIndicators(page);
    const wrapper = chartWrapper(page);
    await expect(wrapper).toHaveAttribute("data-valuation-pane", "true");
    await expect(wrapper).toHaveAttribute("data-fundamental-pane", "true");
    await expect(wrapper).toHaveAttribute(
      "data-pane-order",
      "price,volume,valuation,fundamental",
    );

    // The price chart keeps a useful height above the two new panes, and nothing overflows.
    await settle(page);
    const chartBox = await priceChart(page).boundingBox();
    expect(chartBox!.x + chartBox!.width).toBeLessThanOrEqual(MOBILE.width);
    const pricePane = await priceChart(page)
      .locator("tr")
      .first()
      .boundingBox();
    expect(pricePane!.height).toBeGreaterThanOrEqual(250);
    const key = page.getByRole("list", { name: "Chart key" });
    await expect(key).toContainText("EV/EBITDA");
    const keyBox = await key.boundingBox();
    expect(keyBox!.x + keyBox!.width).toBeLessThanOrEqual(MOBILE.width);
    const seen = await sweepLegend(page, "EV/EBITDA", 10);
    expect([...seen.values()].some((text) => text?.endsWith("x"))).toBe(true);
    const legendBox = await page.getByTestId("chart-legend").boundingBox();
    expect(legendBox!.x + legendBox!.width).toBeLessThanOrEqual(MOBILE.width);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(MOBILE.width);
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("starts from no valuation ratio after a reload, as the overlays start from their defaults", async ({
    page,
  }) => {
    const requests = watchValuationRequests(page);
    await openStock(page);
    await chooseValuation(page, "PRICE_TO_EARNINGS_TTM");
    expect(requests).toHaveLength(1);
    await page.reload();
    await expect(priceChart(page)).toBeVisible();
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    await expect(chartWrapper(page)).not.toHaveAttribute("data-valuation");
    await openIndicators(page);
    await expect(valuationSelect(page)).toHaveValue("");
    // Nothing about a ratio is asked for by the reloaded page.
    expect(requests).toHaveLength(1);
  });
});
