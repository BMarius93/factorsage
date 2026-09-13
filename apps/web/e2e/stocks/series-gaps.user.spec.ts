import { MOVING_AVERAGE_SERIES } from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Genuinely unavailable intervals stay gaps, through the real Next + Nest + PostgreSQL + Redis
 * stack.
 *
 * The bug this suite exists for: Stock Details drew a straight line *through* every interval an
 * intrinsic model was not calculable for. `AMZN`'s `Balanced` became one diagonal across the 442
 * trading days its DCF component was unavailable, and `AAPL`'s `DDM` a single straight line across
 * the 1996-2012 dividend suspension — both inventing intrinsic values the backend had deliberately
 * not materialized. "The model could not be calculated here" and "the value did not change" are
 * different facts and must not look the same.
 *
 * Lines live on a canvas, so this asserts the DOM contract the chart publishes for the purpose —
 * `data-series-gaps`, one `id:count` per drawn overlay — in the same way the viewport suites assert
 * `data-visible-range` and the oscillator suite asserts `data-oscillator-levels`.
 *
 * Preconditions are the usual Stock Details ones: `pnpm test:users:seed` once and
 * `pnpm test:securities:seed` shortly before the run. `QATEST1` is seeded with a deliberate
 * interior window where every intrinsic model is not calculable, between two stretches where they
 * are, which is what makes an *interior* gap assertable rather than only a leading warm-up.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };

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

function rangePill(page: Page, range: string): Locator {
  return page
    .getByRole("group", { name: "Chart range" })
    .getByText(range, { exact: true });
}

/** `data-series-gaps` parsed into `id -> whitespace day count`. */
async function seriesGaps(page: Page): Promise<Record<string, number>> {
  const raw = await chartWrapper(page).getAttribute("data-series-gaps");
  expect(raw).not.toBeNull();
  return Object.fromEntries(
    raw!
      .split(",")
      .filter(Boolean)
      .map((entry) => {
        const [id, count] = entry.split(":");
        return [id!, Number(count)] as const;
      }),
  );
}

async function openStock(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  await expect(priceChart(page)).toBeVisible();
  // MAX brings the whole seeded history in, which is where the unavailable window lives.
  await rangePill(page, "MAX").click();
  await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
}

test.describe("PRO_USER Stock Details unavailable intervals", () => {
  test("breaks an intrinsic line across a genuinely unavailable interval @smoke", async ({
    page,
  }) => {
    await openStock(page);

    // Balanced is the catalog's default selection, so it is already drawn.
    await expect
      .poll(async () => (await seriesGaps(page)).BALANCED)
      .toBeGreaterThan(0);
  });

  test("keeps continuous technical series unbroken over the same history", async ({
    page,
  }) => {
    await openStock(page);
    await page.getByTestId("indicators-trigger").click();

    // A moving average is continuous after warm-up: leading absence draws nothing and needs no
    // marker, and there is no interior day it is missing. Taken from the catalog rather than a
    // literal, so this cannot drift from the product definition.
    const average = MOVING_AVERAGE_SERIES[0]!;
    await panel(page)
      .getByRole("checkbox", { name: average.label, exact: true })
      .check();
    await page.keyboard.press("Escape");

    await expect.poll(async () => (await seriesGaps(page))[average.id]).toBe(0);
    // ...while the intrinsic overlay drawn beside it still reports its unavailable interval, so
    // this is a per-series property and not a chart-wide setting.
    expect((await seriesGaps(page)).BALANCED).toBeGreaterThan(0);
  });
});
