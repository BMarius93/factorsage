import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The hard bounds of the Stock Details time domain, driven through real gestures.
 *
 * These behaviours only exist on a canvas. A unit test can prove the chart was *told* where its
 * boundary is; only a browser can prove that a wheel, a drag or a pinch is actually refused at it,
 * because the refusal lives inside Lightweight Charts' own gesture handling rather than in any
 * code this repository runs per event. So every assertion here pairs a gesture with the viewport
 * the chart publishes afterwards.
 *
 * The domain is `[history.start, latest trading day]` — the thirty-year product horizon narrowed
 * by the deployment's retention and the security's listing date, as the API reports it. The chart
 * publishes it as `data-domain-from`/`data-domain-to`, which is what these tests navigate against
 * rather than recomputing the bound a second time.
 *
 * Preconditions are the usual Stock Details ones: `pnpm test:users:seed` once, and
 * `pnpm test:securities:seed` shortly before the run.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

/** The chart wrapper — the canvas container's parent — carrying the viewport contract. */
function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..").first();
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
async function settle(page: Page): Promise<void> {
  await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
  await settleFrames(page);
}

async function openStock(
  page: Page,
  viewport = DESKTOP,
): Promise<{ from: string; to: string }> {
  await page.setViewportSize(viewport);
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(priceChart(page)).toBeVisible();
  await expect(chartWrapper(page)).toHaveAttribute(
    "data-visible-range",
    /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/,
  );
  const wrapper = chartWrapper(page);
  const from = await wrapper.getAttribute("data-domain-from");
  const to = await wrapper.getAttribute("data-domain-to");
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return { from: from!, to: to! };
}

async function visibleRange(page: Page): Promise<{ from: string; to: string }> {
  await settleFrames(page);
  const raw = await chartWrapper(page).getAttribute("data-visible-range");
  expect(raw).not.toBeNull();
  const [from, to] = raw!.split("|");
  return { from: from!, to: to! };
}

/** The raw bar-index window. Negative `from` is empty space to the left of the oldest bar. */
async function visibleLogical(
  page: Page,
): Promise<{ from: number; to: number }> {
  await settleFrames(page);
  const raw = await chartWrapper(page).getAttribute("data-visible-logical");
  expect(raw).not.toBeNull();
  const [from, to] = raw!.split("|");
  return { from: Number(from), to: Number(to) };
}

/** Bars the chart currently holds, which is where "past the newest bar" starts. */
async function barCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>("[data-loaded-from]");
    return Number(wrapper?.dataset.barCount ?? "0");
  });
}

/** Drags horizontally across the plot. Positive `dx` walks back through history. */
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

async function wheelOverChart(
  page: Page,
  deltaY: number,
  ticks: number,
): Promise<void> {
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  for (let tick = 0; tick < ticks; tick += 1) {
    await page.mouse.wheel(0, deltaY);
  }
}

test.describe("PRO_USER Stock Details chart bounds", () => {
  test("never opens empty space after the latest trading day @smoke", async ({
    page,
  }) => {
    const domain = await openStock(page);
    const opened = await visibleRange(page);
    expect(opened.to <= domain.to).toBe(true);

    // Dragging towards the future, repeatedly and hard. Every one of these is refused at the
    // newest bar rather than opening blank canvas the user then has to drag back out of.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await dragChart(page, -600);
      await settleFrames(page);
      const range = await visibleRange(page);
      expect(range.to <= domain.to).toBe(true);
    }

    // The right edge is pinned, so the window that ends up on screen still ends at real data.
    const settled = await visibleRange(page);
    expect(settled.to <= domain.to).toBe(true);
    // ...and the viewport never runs past the last bar in logical terms either, which is what
    // "no empty space to the right of today" means before any date is resolved.
    const logical = await visibleLogical(page);
    const bars = await barCount(page);
    if (bars > 0) {
      expect(logical.to).toBeLessThanOrEqual(bars + 1);
    }
  });

  test("never navigates before the permitted history, however far it is zoomed out", async ({
    page,
  }) => {
    const domain = await openStock(page);

    // Zoom out as far as the wheel will take it, then keep dragging backwards. Both gestures are
    // ways past the thirty-year bound, and both have to stop at it.
    await wheelOverChart(page, 120, 30);
    await settle(page);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await dragChart(page, 900);
      await settle(page);
      const range = await visibleRange(page);
      // Every window resolves to dates inside the permitted domain. A window that had walked past
      // the bound would resolve its left edge before `domain.from`, or to nothing at all.
      expect(range.from >= domain.from).toBe(true);
      expect(range.to <= domain.to).toBe(true);
    }

    // Once the boundary is reached the chart says so, and the oldest bar is the boundary itself
    // rather than wherever a gesture happened to stop.
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-history-exhausted",
      "true",
    );
    const oldest = await chartWrapper(page).getAttribute("data-loaded-from");
    expect(oldest).toBe(domain.from);

    // At the boundary the left edge is pinned by the library itself: more dragging cannot open
    // blank space before the first bar.
    await dragChart(page, 900);
    await settleFrames(page);
    const pinned = await visibleLogical(page);
    expect(pinned.from).toBeGreaterThan(-2);
  });

  test("keeps its bounds when a range is picked and when the series change", async ({
    page,
  }) => {
    const domain = await openStock(page);

    // MAX frames the whole permitted horizon. Framing is a programmatic range change, and it is
    // bounded by exactly the same domain a gesture is.
    await page
      .getByRole("group", { name: "Chart range" })
      .getByText("MAX", { exact: true })
      .click();
    await expect(page.getByRole("radio", { name: "MAX" })).toBeChecked();
    await settle(page);
    const framed = await visibleRange(page);
    expect(framed.from >= domain.from).toBe(true);
    expect(framed.to <= domain.to).toBe(true);

    // Enabling an indicator rewrites every series and adds a pane. The bounds are a property of
    // the chart's domain, not of the series drawn in it, so they have to survive that.
    await page.getByTestId("indicators-trigger").click();
    const panel = page.getByTestId("indicators-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("checkbox", { name: "RSI 14D", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-oscillator-pane",
      "true",
    );
    await settle(page);

    await dragChart(page, -900);
    await settleFrames(page);
    const afterFuturePan = await visibleRange(page);
    expect(afterFuturePan.to <= domain.to).toBe(true);

    await dragChart(page, 1_200);
    await settle(page);
    const afterPastPan = await visibleRange(page);
    expect(afterPastPan.from >= domain.from).toBe(true);
  });

  test("holds its bounds through a resize, including on a phone", async ({
    page,
  }) => {
    const domain = await openStock(page);
    await wheelOverChart(page, 120, 10);
    await settle(page);

    // A resize is not navigation. The window survives it, and it survives it inside the domain.
    await page.setViewportSize(PHONE);
    await settleFrames(page);
    const resized = await visibleRange(page);
    expect(resized.from >= domain.from).toBe(true);
    expect(resized.to <= domain.to).toBe(true);

    // And the phone's own gestures are bounded the same way, at a width where a given drag
    // covers far more of the domain per pixel.
    await dragChart(page, -400);
    await settleFrames(page);
    expect((await visibleRange(page)).to <= domain.to).toBe(true);
    await dragChart(page, 1_600);
    await settle(page);
    expect((await visibleRange(page)).from >= domain.from).toBe(true);
  });
});
