import { OSCILLATOR_SERIES } from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Stock Details RSI oscillator journey for QA_USER, through the real Next + Nest + PostgreSQL +
 * Redis stack.
 *
 * Preconditions are the same as the indicators journey: `pnpm test:users:seed` once, and
 * `pnpm test:securities:seed` shortly before the run. That seed materializes the RSI family with
 * the production Wilder calculator (`buildDailyDerivedState`), and its coverage watermarks keep
 * the canonical loader off any market-data provider — no FMP key is needed or used.
 */

const QA_SYMBOL = "QATEST1";

/** Canonical group content from the catalog, not a copy kept by this suite. */
const OSCILLATOR_LABELS = OSCILLATOR_SERIES.map((series) => series.label);

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

type PageIssues = {
  readonly consoleErrors: string[];
  readonly failedRequests: string[];
};

/** Records console errors (hydration warnings included) and failed responses for the whole test. */
function watchForIssues(page: Page): PageIssues {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  return { consoleErrors, failedRequests };
}

function panel(page: Page): Locator {
  return page.getByTestId("indicators-panel");
}

function option(page: Page, name: string): Locator {
  return panel(page).getByRole("checkbox", { name, exact: true });
}

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

/** The chart wrapper — the canvas container's parent — carrying the pane's DOM contract. */
function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..");
}

async function openStock(page: Page): Promise<void> {
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  await expect(priceChart(page)).toBeVisible();
}

async function openIndicators(page: Page): Promise<void> {
  await page.getByTestId("indicators-trigger").click();
  await expect(panel(page)).toBeVisible();
}

/**
 * Canvases inside the chart. The library renders each pane with its own canvases, so the count is
 * a duplication-proof fingerprint: enabling the pane raises it by a fixed amount, disabling it
 * restores the baseline exactly, and re-enabling reproduces the first enabled count.
 */
async function chartCanvasCount(page: Page): Promise<number> {
  // The library attaches pane DOM on an animation frame, so settle two frames before counting.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
  return priceChart(page).locator("canvas").count();
}

/**
 * Asserts exactly which RSI periods are currently drawn, read from the chart's own hover legend.
 *
 * The legend is populated from the series data the chart holds, so it is the browser-visible
 * contract for "this line exists" — no canvas-pixel inspection, and it fails if a deselected
 * period keeps drawing or a selected one silently stops.
 */
async function expectDrawnOscillators(
  page: Page,
  expected: readonly string[],
): Promise<void> {
  if (await panel(page).isVisible()) {
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
  }
  const box = await priceChart(page).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.3);
  const legend = page.getByTestId("chart-legend");
  await expect(legend).toContainText("Close");
  for (const label of OSCILLATOR_LABELS) {
    if (expected.includes(label)) {
      await expect(legend).toContainText(label);
      // Unitless: an RSI reading is never formatted as money.
      await expect(legend).not.toContainText(`${label}$`);
    } else {
      await expect(legend).not.toContainText(label);
    }
  }
}

async function expectPane(page: Page, active: boolean): Promise<void> {
  const wrapper = chartWrapper(page).first();
  if (active) {
    await expect(wrapper).toHaveAttribute("data-oscillator-pane", "true");
    await expect(wrapper).toHaveAttribute("data-oscillator-levels", "30,50,70");
  } else {
    await expect(wrapper).not.toHaveAttribute("data-oscillator-pane", "true");
  }
}

test.describe("QA_USER Stock Details oscillators", () => {
  test("drives the shared RSI pane through the full selection lifecycle", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await page.setViewportSize(DESKTOP);
    await openStock(page);
    await openIndicators(page);

    // 2. The Oscillators group exists with the three periods in canonical order, all off, all
    //    available: the seeded history warms up every period.
    const group = panel(page).locator("fieldset", {
      has: page.locator("legend", { hasText: "Oscillators" }),
    });
    await expect(group.getByRole("checkbox")).toHaveCount(
      OSCILLATOR_LABELS.length,
    );
    await expect(group.locator("label")).toHaveText(OSCILLATOR_LABELS);
    for (const label of OSCILLATOR_LABELS) {
      await expect(option(page, label)).not.toBeChecked();
      await expect(option(page, label)).toBeEnabled();
    }
    const baselineCanvases = await chartCanvasCount(page);

    // 3. The first RSI creates the lower pane.
    await option(page, "RSI 7D").check();
    await expectPane(page, true);
    await expect
      .poll(() => chartCanvasCount(page))
      .toBeGreaterThan(baselineCanvases);
    const paneCanvases = await chartCanvasCount(page);

    // 4. The other two periods join the same pane: no further canvases, one shared pane.
    await option(page, "RSI 14D").check();
    await option(page, "RSI 21D").check();
    await expectPane(page, true);
    expect(await chartCanvasCount(page)).toBe(paneCanvases);

    // 6. A price overlay stays enabled beside the oscillators throughout (Balanced is the
    //    default selection and was never turned off).
    await expect(option(page, "Balanced")).toBeChecked();

    // 5. The hover legend names every enabled series; RSI readings are unitless, never money.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    const chartBox = await priceChart(page).boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(
      chartBox!.x + chartBox!.width * 0.6,
      chartBox!.y + chartBox!.height * 0.3,
    );
    const legend = page.getByTestId("chart-legend");
    await expect(legend).toContainText("Close");
    await expect(legend).toContainText("Balanced");
    for (const label of OSCILLATOR_LABELS) {
      await expect(legend).toContainText(label);
      await expect(legend).not.toContainText(`${label}$`);
    }

    // 7. Switch off the period that owns the pane's reference levels. The rest stay drawn and
    //    the 30/50/70 set survives exactly once, having moved to the next period.
    await openIndicators(page);
    await option(page, "RSI 7D").uncheck();
    await expect(option(page, "RSI 14D")).toBeChecked();
    await expect(option(page, "RSI 21D")).toBeChecked();
    await expectPane(page, true);
    await expectDrawnOscillators(page, ["RSI 14D", "RSI 21D"]);

    // The new owner can be switched off too, handing the levels on again.
    await openIndicators(page);
    await option(page, "RSI 14D").uncheck();
    await expect(option(page, "RSI 21D")).toBeChecked();
    await expectPane(page, true);
    await expectDrawnOscillators(page, ["RSI 21D"]);

    // 8. Toggling the last period off removes the pane, its levels, and restores the
    //    price-only layout.
    await openIndicators(page);
    await option(page, "RSI 21D").uncheck();
    await expectPane(page, false);
    await expect.poll(() => chartCanvasCount(page)).toBe(baselineCanvases);
    await expectDrawnOscillators(page, []);

    // 9. Re-enabling reproduces exactly one pane, one levels set and one line per period.
    await openIndicators(page);
    await option(page, "RSI 7D").check();
    await option(page, "RSI 14D").check();
    await option(page, "RSI 21D").check();
    await expectPane(page, true);
    await expect.poll(() => chartCanvasCount(page)).toBe(paneCanvases);
    await expectDrawnOscillators(page, [...OSCILLATOR_LABELS]);

    // 12. Nothing broke along the way.
    const documentWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(documentWidth).toBeLessThanOrEqual(DESKTOP.width);
    expect(
      issues.consoleErrors.filter((message) => /hydrat/i.test(message)),
    ).toEqual([]);
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("keeps the pane and the price chart usable on a phone viewport", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await page.setViewportSize(MOBILE);
    await openStock(page);
    await openIndicators(page);

    // Touch selection of two periods.
    await option(page, "RSI 7D").check();
    await option(page, "RSI 21D").check();
    await page.keyboard.press("Escape");
    await expectPane(page, true);

    // The price chart keeps a useful height above the pane, and the pane itself stays readable
    // rather than collapsing: the wrapper grew for it.
    const chartBox = await priceChart(page).boundingBox();
    expect(chartBox).not.toBeNull();
    expect(chartBox!.height).toBeGreaterThanOrEqual(340);
    expect(chartBox!.x + chartBox!.width).toBeLessThanOrEqual(MOBILE.width);

    // No horizontal overflow anywhere on the page with the pane active.
    const documentWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(documentWidth).toBeLessThanOrEqual(MOBILE.width);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("selects an oscillator from the keyboard alone @smoke", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openStock(page);

    const trigger = page.getByTestId("indicators-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();

    // Tab through the options until the first RSI checkbox holds focus, then toggle with Space —
    // keyboard only, bounded by the catalog size.
    const rsi = option(page, "RSI 7D");
    let focused = false;
    for (let step = 0; step < 40 && !focused; step += 1) {
      await page.keyboard.press("Tab");
      focused = await rsi.evaluate(
        (element) => element === document.activeElement,
      );
    }
    expect(focused).toBe(true);
    await page.keyboard.press("Space");
    await expect(rsi).toBeChecked();
    await expectPane(page, true);

    await page.keyboard.press("Space");
    await expect(rsi).not.toBeChecked();
    await expectPane(page, false);

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
