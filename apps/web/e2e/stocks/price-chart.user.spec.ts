import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Stock Details price-chart navigation for QA_USER, through the real Next + Nest + PostgreSQL +
 * Redis stack.
 *
 * Preconditions are the same as the other Stock Details journeys: `pnpm test:users:seed` once, and
 * `pnpm test:securities:seed` shortly before the run, so the deterministic QA history is present
 * and the loader stays off any market-data provider.
 *
 * The visible window lives on a canvas, so it is asserted through the DOM contract the chart
 * publishes for exactly this purpose, in the same way the oscillator pane publishes its reference
 * levels: `data-visible-range` carries the window in dates, which is what "the user is looking at
 * older history" means and what survives a load prepending bars in front of it, and
 * `data-visible-logical` carries the raw bar-index range.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };

type VisibleRange = { readonly from: string; readonly to: string };

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

/** The chart wrapper — the canvas container's parent — carrying the viewport contract. */
function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..").first();
}

function panel(page: Page): Locator {
  return page.getByTestId("indicators-panel");
}

/**
 * A chart-range pill. The radio input itself is visually replaced by the pill, so a user — and
 * therefore this suite — picks a range by clicking the pill, not the hidden input.
 */
function rangePill(page: Page, range: string): Locator {
  return page
    .getByRole("group", { name: "Chart range" })
    .getByText(range, { exact: true });
}

async function openStock(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  await expect(priceChart(page)).toBeVisible();
  // The chart publishes its window as soon as it has framed the data.
  await expect(chartWrapper(page)).toHaveAttribute(
    "data-visible-range",
    /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/,
  );
}

async function settleFrames(page: Page): Promise<void> {
  // The library repositions on an animation frame; settle two before reading.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}

async function visibleRange(page: Page): Promise<VisibleRange> {
  await settleFrames(page);
  const raw = await chartWrapper(page).getAttribute("data-visible-range");
  expect(raw).not.toBeNull();
  const [from, to] = raw!.split("|");
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return { from: from!, to: to! };
}

/** Calendar days the visible window spans. */
function width(range: VisibleRange): number {
  return (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
}

/**
 * Waits out any history load a gesture started.
 *
 * Panning past the oldest loaded bar is a request for older history, and that request finishing is
 * exactly what must *not* move the viewport. Settling it first is what makes the assertion about
 * a preserved window a real assertion rather than a race that happens to pass.
 */
async function settleHistoryLoad(page: Page): Promise<void> {
  await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
  await settleFrames(page);
}

/** Drags horizontally across the middle of the plot. Negative `dx` walks forward in time. */
async function dragChart(page: Page, dx: number): Promise<void> {
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height * 0.45;
  const startX = box!.x + box!.width * 0.5;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // Several steps: a single jump can be treated as a click rather than a drag.
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + (dx * step) / 8, y);
  }
  await page.mouse.up();
}

test.describe("QA_USER Stock Details price chart navigation", () => {
  test("pans through history by dragging @smoke", async ({ page }) => {
    await openStock(page);
    const before = await visibleRange(page);

    // Dragging the plot to the right pulls older history into view.
    await dragChart(page, 240);
    const after = await visibleRange(page);

    expect(after.from < before.from).toBe(true);
    expect(after.to < before.to).toBe(true);
    // A pan moves the window; it never rescales it. A few days of slack absorbs the fact that a
    // window's edges land on trading days, which are not evenly spaced.
    expect(Math.abs(width(after) - width(before))).toBeLessThan(10);

    // And it works in the other direction, back towards the latest close.
    await dragChart(page, -240);
    const returned = await visibleRange(page);
    expect(returned.from > after.from).toBe(true);
    expect(Math.abs(width(returned) - width(after))).toBeLessThan(10);
  });

  test("zooms the time scale with the wheel", async ({ page }) => {
    await openStock(page);
    const before = await visibleRange(page);

    const box = await priceChart(page).boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    for (let tick = 0; tick < 5; tick += 1) {
      await page.mouse.wheel(0, -120);
    }
    const zoomedIn = await visibleRange(page);
    expect(width(zoomedIn)).toBeLessThan(width(before) * 0.9);
    // Zooming in keeps drawing: the window still resolves to real trading days.
    expect(width(zoomedIn)).toBeGreaterThan(0);

    for (let tick = 0; tick < 10; tick += 1) {
      await page.mouse.wheel(0, 120);
    }
    const zoomedOut = await visibleRange(page);
    expect(width(zoomedOut)).toBeGreaterThan(width(zoomedIn) * 1.1);
  });

  test("keeps a manually chosen window across an ordinary rerender", async ({
    page,
  }) => {
    await openStock(page);

    // Put the chart somewhere the user chose and nothing else would have picked. Dragging past
    // the loaded edge starts a history load, so settle it before reading the chosen window —
    // otherwise the assertion would race the very thing it is checking is harmless.
    await dragChart(page, 200);
    await settleHistoryLoad(page);
    const box = await priceChart(page).boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    for (let tick = 0; tick < 3; tick += 1) {
      await page.mouse.wheel(0, -120);
    }
    const chosen = await visibleRange(page);

    // Toggling an indicator rerenders the chart's React tree and rewrites its series data.
    await page.getByTestId("indicators-trigger").click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole("checkbox", { name: "SMA 50D", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();

    expect(await visibleRange(page)).toEqual(chosen);

    // Turning it back off is another rerender, and still not a request to reframe.
    await page.getByTestId("indicators-trigger").click();
    await panel(page)
      .getByRole("checkbox", { name: "SMA 50D", exact: true })
      .uncheck();
    await page.keyboard.press("Escape");

    expect(await visibleRange(page)).toEqual(chosen);
  });

  test("reframes only when the user picks a different range", async ({
    page,
  }) => {
    await openStock(page);
    await dragChart(page, 220);
    await settleHistoryLoad(page);
    const panned = await visibleRange(page);

    // An explicit range change is the one thing that is allowed to move the window.
    await rangePill(page, "3M").click();
    await expect(
      page.getByRole("radio", { name: "3M", exact: true }),
    ).toBeChecked();
    const reframed = await visibleRange(page);
    expect(reframed).not.toEqual(panned);

    // ...and the new range is then the user's to navigate again.
    await dragChart(page, 160);
    const afterPan = await visibleRange(page);
    expect(afterPan.from < reframed.from).toBe(true);
  });
});
