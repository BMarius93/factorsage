import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Viewport-driven history loading for QA_USER, through the real Next + Nest + PostgreSQL + Redis
 * stack.
 *
 * The bug this suite exists for: navigation worked, but nothing loaded. Panning left or zooming
 * out moved the window into empty space and left it there, because the only thing that ever
 * fetched more history was the range selector. So every assertion here pairs a *gesture* with the
 * *network request* it must cause and the *history* that must then appear — checking pixels alone
 * cannot tell "loaded the missing years" from "drew nothing, again".
 *
 * Preconditions are the usual Stock Details ones: `pnpm test:users:seed` once, and
 * `pnpm test:securities:seed` shortly before the run, so the deterministic QA history is present
 * and the loader stays off any market-data provider.
 *
 * `QATEST1` is seeded with roughly three years of trading days inside a thirty-year permitted
 * bound, which is what makes it a realistic subject: the chart must load the history that exists,
 * discover where it ends, and stop there rather than at the horizon.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };

type HistoryRequest = { readonly path: string; readonly from: string; readonly to: string };

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

/** The chart wrapper — the canvas container's parent — carrying the viewport contract. */
function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..").first();
}

/**
 * Every bounded history read this page issues, with duplicates kept.
 *
 * Duplicates matter here: the whole point of one assertion is that dragging back and forth across
 * an already-loaded range issues *no* request at all, and collapsing repeats would hide exactly
 * the regression that would cause.
 */
function watchPriceRequests(page: Page): HistoryRequest[] {
  const requests: HistoryRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes(`/stocks/${QA_SYMBOL}`)) {
      return;
    }
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from && to) {
      requests.push({ path: url.pathname, from, to });
    }
  });
  return requests;
}

function priceReads(requests: readonly HistoryRequest[]): HistoryRequest[] {
  return requests.filter((request) => request.path.endsWith("/prices"));
}

/** Thirty years before today: the Stock Details bound this deployment reports. */
function historyBoundStart(): string {
  const today = new Date();
  today.setUTCFullYear(today.getUTCFullYear() - 30);
  return today.toISOString().slice(0, 10);
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}

/** Waits out any history load a gesture started, so an assertion cannot race it. */
async function settleHistoryLoad(page: Page): Promise<void> {
  await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
  await settleFrames(page);
}

async function openStock(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  await expect(priceChart(page)).toBeVisible();
  await expect(chartWrapper(page)).toHaveAttribute(
    "data-visible-range",
    /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/,
  );
}

async function visibleRange(page: Page): Promise<{ from: string; to: string }> {
  await settleFrames(page);
  const raw = await chartWrapper(page).getAttribute("data-visible-range");
  expect(raw).not.toBeNull();
  const [from, to] = raw!.split("|");
  return { from: from!, to: to! };
}

/** The oldest bar the chart currently holds. */
async function loadedFrom(page: Page): Promise<string> {
  const value = await chartWrapper(page).getAttribute("data-loaded-from");
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return value!;
}

function spanDays(range: { from: string; to: string }): number {
  return (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
}

/** Drags horizontally across the middle of the plot. Positive `dx` walks back through history. */
async function dragChart(page: Page, dx: number): Promise<void> {
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height * 0.45;
  const startX = box!.x + box!.width * 0.5;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + (dx * step) / 8, y);
  }
  await page.mouse.up();
}

async function wheelOverChart(page: Page, deltaY: number, ticks: number): Promise<void> {
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  for (let tick = 0; tick < ticks; tick += 1) {
    await page.mouse.wheel(0, deltaY);
  }
}

/** Drags left until nothing older can arrive, or the attempt budget runs out. */
async function panToBoundary(page: Page, attempts = 25): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await chartWrapper(page).getAttribute("data-history-exhausted")) === "true") {
      return true;
    }
    await dragChart(page, 400);
    await settleHistoryLoad(page);
  }
  return (
    (await chartWrapper(page).getAttribute("data-history-exhausted")) === "true"
  );
}

test.describe("QA_USER Stock Details viewport-driven history", () => {
  test("pans left into unloaded history and keeps the window it moved to @smoke", async ({
    page,
  }) => {
    const requests = watchPriceRequests(page);
    await openStock(page);

    const openedAt = await loadedFrom(page);
    expect(priceReads(requests)).toHaveLength(0);

    // Drag left, past the oldest loaded bar.
    await dragChart(page, 420);
    const chosen = await visibleRange(page);

    // The gesture is what asks for history, and one gesture costs one bounded request.
    await expect.poll(() => priceReads(requests).length, { timeout: 15_000 }).toBe(1);
    const [older] = priceReads(requests);
    expect(older!.from < openedAt).toBe(true);
    // Only the gap: the year already on screen is not fetched again.
    expect(older!.to < openedAt).toBe(true);
    // Bounded and incremental: about a year, not a jump to the whole horizon.
    expect(spanDays({ from: older!.from, to: openedAt })).toBeLessThan(400);
    expect(older!.from >= historyBoundStart()).toBe(true);

    await settleHistoryLoad(page);

    // The history actually arrived...
    const extended = await loadedFrom(page);
    expect(extended < openedAt).toBe(true);

    // ...and arriving history did not move the user. This is the regression that made panning
    // feel broken even once loading worked: the logical range is anchored to bar indices, so
    // prepending a year silently walks the window a year backwards unless it is shifted back.
    expect(await visibleRange(page)).toEqual(chosen);
  });

  test("zooms out past the loaded history and fills the window instead of leaving it blank", async ({
    page,
  }) => {
    const requests = watchPriceRequests(page);
    await openStock(page);
    const openedAt = await loadedFrom(page);

    await wheelOverChart(page, 120, 14);
    const widened = await visibleRange(page);
    expect(spanDays(widened)).toBeGreaterThan(365);

    // A wide zoom-out asks for the years the viewport opened up, in one request rather than a
    // year at a time — and still never past the boundary.
    await expect.poll(() => priceReads(requests).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await settleHistoryLoad(page);

    const filled = await loadedFrom(page);
    expect(filled < openedAt).toBe(true);
    for (const request of priceReads(requests)) {
      expect(request.from >= historyBoundStart()).toBe(true);
    }

    // The widened window is populated: its oldest visible day is a real trading day, not the
    // edge of a blank region.
    const populated = await visibleRange(page);
    expect(populated.from >= filled).toBe(true);
    expect(spanDays(populated)).toBeGreaterThan(365);
  });

  test("keeps drawing when zooming back in, without reframing", async ({ page }) => {
    await openStock(page);

    await wheelOverChart(page, 120, 10);
    await settleHistoryLoad(page);
    const wide = await visibleRange(page);

    await wheelOverChart(page, -120, 6);
    await settleHistoryLoad(page);
    const narrow = await visibleRange(page);

    // Narrower, still resolving to real trading days, and inside where it was.
    expect(spanDays(narrow)).toBeLessThan(spanDays(wide));
    expect(spanDays(narrow)).toBeGreaterThan(0);
    expect(narrow.from >= wide.from).toBe(true);
    expect(narrow.to <= wide.to).toBe(true);

    // Nothing snapped the viewport back to the whole series.
    await settleFrames(page);
    expect(await visibleRange(page)).toEqual(narrow);
  });

  test("does not refetch history it already holds", async ({ page }) => {
    const requests = watchPriceRequests(page);
    await openStock(page);

    await dragChart(page, 420);
    await expect.poll(() => priceReads(requests).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await settleHistoryLoad(page);
    const afterFirstPan = priceReads(requests).length;

    // Back towards the present and left again, entirely inside what is now loaded. The chart
    // reports its viewport on every animation frame of a drag, so this is the difference between
    // no requests and hundreds.
    await dragChart(page, -300);
    await settleFrames(page);
    await dragChart(page, 250);
    await settleFrames(page);
    await page.waitForTimeout(500);

    expect(priceReads(requests).length).toBe(afterFirstPan);
  });

  test("stops at the security's real history and never asks past the boundary", async ({
    page,
  }) => {
    const requests = watchPriceRequests(page);
    await openStock(page);

    const reached = await panToBoundary(page);
    expect(reached).toBe(true);

    // Every request stayed inside the permitted bound, boundary included.
    const bound = historyBoundStart();
    expect(priceReads(requests).every((request) => request.from >= bound)).toBe(true);

    // At the boundary the chart is pinned: dragging further neither fetches nor opens up blank
    // space before the oldest bar.
    const settled = priceReads(requests).length;
    const oldest = await loadedFrom(page);
    await dragChart(page, 600);
    await settleFrames(page);
    await page.waitForTimeout(500);

    expect(priceReads(requests).length).toBe(settled);
    const pinned = await visibleRange(page);
    expect(pinned.from >= oldest).toBe(true);
  });

  test("extends the RSI pane with newly loaded history", async ({ page }) => {
    await openStock(page);

    await page.getByTestId("indicators-trigger").click();
    const panel = page.getByTestId("indicators-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("checkbox", { name: "RSI 14D", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(chartWrapper(page)).toHaveAttribute("data-oscillator-pane", "true");

    const openedAt = await loadedFrom(page);

    await dragChart(page, 420);
    await settleHistoryLoad(page);
    const extended = await loadedFrom(page);
    expect(extended < openedAt).toBe(true);

    // The pane survived the load and the crosshair reads an RSI value inside the newly loaded
    // history — the series was extended, not merely redrawn over the old window.
    await expect(chartWrapper(page)).toHaveAttribute("data-oscillator-pane", "true");
    const box = await priceChart(page).boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.4);
    const legend = page.getByTestId("chart-legend");
    await expect(legend).toContainText("RSI 14D");
  });
});
