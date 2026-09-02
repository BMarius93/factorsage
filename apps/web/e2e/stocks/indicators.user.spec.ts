import {
  SELECTABLE_SERIES_CATALOG,
  SELECTABLE_SERIES_GROUPED,
} from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Stock Details `Indicators` catalog journey for QA_USER, through the real application boundary.
 *
 * Preconditions beyond the usual running stack and `pnpm test:users:seed`: the deterministic QA
 * catalog rows and their market data must exist — run `pnpm test:securities:seed` shortly before
 * the suite. That seed also writes the dataset coverage watermarks that keep the canonical loader
 * from reaching for a market-data provider, so this suite never depends on FMP and never assumes a
 * real market symbol exists in the environment's catalog.
 */

const QA_SYMBOL = "QATEST1";

/**
 * The catalog's groups and size come from the canonical catalog, not a copy.
 *
 * The browser assertions below are about what the real page renders; what it is supposed to render
 * is product state owned by `@intrinsic/contracts` and pinned by its own snapshot test. Restating
 * it here would make this suite a second catalog that silently goes stale.
 */
const GROUPS = SELECTABLE_SERIES_GROUPED.map((group) => group.label);
const CATALOG_SIZE = SELECTABLE_SERIES_CATALOG.length;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

type PageIssues = {
  readonly consoleErrors: string[];
  readonly failedRequests: string[];
};

/** Records console errors and non-2xx/3xx API responses for the whole test. */
function watchForIssues(page: Page): PageIssues {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
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

async function openStock(page: Page): Promise<void> {
  await page.goto(`/stocks/${QA_SYMBOL}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
  // The price chart is the always-visible base series; everything else is an overlay on top of it.
  await expect(priceChart(page)).toBeVisible();
}

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

async function openIndicators(page: Page): Promise<void> {
  await page.getByTestId("indicators-trigger").click();
  await expect(panel(page)).toBeVisible();
}

test.describe("QA_USER Stock Details indicators", () => {
  test("exposes the whole selectable-series catalog and drives the chart from it", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    await page.setViewportSize(DESKTOP);
    await openStock(page);
    await openIndicators(page);

    // 1. Every group, in canonical order, with every catalog entry discoverable.
    await expect(panel(page).locator("legend")).toHaveText(GROUPS);
    await expect(panel(page).getByRole("checkbox")).toHaveCount(CATALOG_SIZE);

    // 2. Balanced is the only overlay enabled by default.
    await expect(option(page, "Balanced")).toBeChecked();
    await expect(page.getByTestId("indicators-trigger")).toContainText("1");

    // 3. An unavailable entry stays visible, disabled and identified. The seeded history is long
    //    enough for 100W but deliberately short of 200W.
    await expect(option(page, "SMA 200W Unavailable")).toBeDisabled();
    await expect(option(page, "EMA 200W Unavailable")).toBeDisabled();
    await expect(option(page, "SMA 100W")).toBeEnabled();

    // 4. A daily moving average, a weekly moving average and an intrinsic-value model on top of
    //    the default blend: four simultaneous overlays spanning every catalog family.
    await option(page, "SMA 50D").check();
    await option(page, "SMA 20W").check();
    await option(page, "DCF (FCFF)").check();
    for (const name of ["SMA 50D", "SMA 20W", "DCF (FCFF)", "Balanced"]) {
      await expect(option(page, name)).toBeChecked();
    }
    await expect(page.getByTestId("indicators-trigger")).toContainText("4");

    // 5. The legend names every enabled series with the same labels as the picker, alongside the
    //    always-present close.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    const chartBox = await priceChart(page).boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(
      chartBox!.x + chartBox!.width * 0.7,
      chartBox!.y + chartBox!.height / 2,
    );
    const legend = page.getByTestId("chart-legend");
    await expect(legend).toContainText("Close");
    await expect(legend).toContainText("SMA 50D");
    await expect(legend).toContainText("SMA 20W");
    await expect(legend).toContainText("DCF (FCFF)");
    await expect(legend).toContainText("Balanced");

    // 6. Deselection removes overlays and leaves price as the base series.
    await openIndicators(page);
    for (const name of ["SMA 50D", "SMA 20W", "DCF (FCFF)", "Balanced"]) {
      await option(page, name).uncheck();
      await expect(option(page, name)).not.toBeChecked();
    }
    await expect(page.getByTestId("indicators-trigger")).not.toContainText("4");
    await page.keyboard.press("Escape");
    await expect(priceChart(page)).toBeVisible();

    // 7. Selecting a different blend proves the blend group is wired to real backend data.
    await openIndicators(page);
    await option(page, "Conservative").check();
    await expect(option(page, "Conservative")).toBeChecked();

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("offers the same catalog on a phone viewport", async ({ page }) => {
    const issues = watchForIssues(page);
    await page.setViewportSize(MOBILE);
    await openStock(page);
    await openIndicators(page);

    await expect(panel(page).locator("legend")).toHaveText(GROUPS);
    await expect(panel(page).getByRole("checkbox")).toHaveCount(CATALOG_SIZE);
    // The popover must stay inside the viewport rather than overflowing the page horizontally.
    const box = await panel(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);

    // Touch selection works the same as on desktop.
    await option(page, "EMA 50W").check();
    await expect(option(page, "EMA 50W")).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(priceChart(page)).toBeVisible();

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("renders canonical catalog labels in the valuation summary on both viewports", async ({
    page,
  }) => {
    // The valuation summary once kept its own label map and drifted from the catalog. These are
    // the canonical labels, asserted through the real page at both widths so a reintroduced
    // second label vocabulary — or a label that no longer fits — fails here.
    const canonicalModelLabels = new Set(
      SELECTABLE_SERIES_CATALOG.filter(
        (series) => series.source.kind === "INTRINSIC_VALUE_MODEL",
      ).map((series) => series.label),
    );

    for (const viewport of [DESKTOP, MOBILE]) {
      await page.setViewportSize(viewport);
      await openStock(page);

      const labels = page.locator('[class*="modelLabel"]');
      const count = await labels.count();
      expect(count).toBeGreaterThan(0);

      for (let index = 0; index < count; index += 1) {
        const row = labels.nth(index);
        // The stale-date note is a child span, so compare on the label's own leading text.
        const text = ((await row.textContent()) ?? "").trim();
        const label = [...canonicalModelLabels].find((candidate) =>
          text.startsWith(candidate),
        );
        expect(label, `unrecognised model label: ${text}`).toBeDefined();

        // Whatever the label's length, the row must stay inside the viewport: no horizontal
        // overflow and no truncation, wrapping to a second line if it needs to.
        const box = await row.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }

      const documentWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(documentWidth).toBeLessThanOrEqual(viewport.width);
    }
  });

  test("opens and operates the picker from the keyboard alone @smoke", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openStock(page);

    const trigger = page.getByTestId("indicators-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();

    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(option(page, "SMA 20D")).toBeChecked();

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
