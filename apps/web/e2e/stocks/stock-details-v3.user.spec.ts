import {
  FUNDAMENTAL_METRIC_CATALOG,
  VALUATION_RATIO_CATALOG,
  type StockSummaryResponse,
} from "@intrinsic/contracts";
import {
  formatFundamentalValue,
  formatLocalDate,
  formatMoney,
  formatMultiple,
  formatOscillator,
} from "../../src/features/stocks/details/utils/format";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { watchForIssues } from "../utils/page-issues";

/**
 * Stock Details V3 for PRO_USER through the real Next + Nest + PostgreSQL + Redis stack: the
 * summary and the chart load independently, every financial card states the API's own reading,
 * and a card puts its series on the chart.
 *
 * Timing is never asserted by waiting on a clock. Where an order matters, one request is held at the
 * network boundary (`page.route`) until the other section has rendered, which proves the rendered
 * section did not wait for the held one; the held request is then released and must render too.
 */

const QA_SYMBOL = "QATEST1";
const DESKTOP = { width: 1440, height: 900 };
const SUMMARY = new RegExp(`/stocks/${QA_SYMBOL}/summary$`);
const CHART = new RegExp(`/stocks/${QA_SYMBOL}\\?from=`);

function priceChart(page: Page): Locator {
  return page.getByRole("img", {
    name: new RegExp(`${QA_SYMBOL} daily closing price chart`),
  });
}

function chartWrapper(page: Page): Locator {
  return priceChart(page).locator("..").first();
}

function card(page: Page, title: string): Locator {
  return page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: title, exact: true }),
  });
}

async function summaryFromApi(page: Page): Promise<StockSummaryResponse> {
  const response = await page.request.get(
    `${apiBaseUrl()}/stocks/${QA_SYMBOL}/summary`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as StockSummaryResponse;
}

/** Holds every request matching `pattern` until `release` is called. */
async function hold(page: Page, pattern: RegExp) {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

test.describe("PRO_USER Stock Details V3", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test("states every reading of the summary in its card, in its unit and with its own date @smoke", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const summary = await summaryFromApi(page);
    await page.goto(`/stocks/${QA_SYMBOL}`);
    await expect(page.getByTestId("stock-research")).toBeVisible();
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    const asOf = summary.quote?.date;
    expect(asOf).toBeDefined();

    // The five ratios, each exactly as the API computed it, or "Unavailable" — never zero.
    expect(summary.valuationRatios.status).toBe("AVAILABLE");
    const ratios =
      summary.valuationRatios.status === "AVAILABLE"
        ? summary.valuationRatios.readings
        : [];
    expect(ratios.map((reading) => reading.id)).toEqual(
      VALUATION_RATIO_CATALOG.map((entry) => entry.id),
    );
    for (const reading of ratios) {
      const row = page.getByTestId(`valuation-ratio-${reading.id}`);
      if (reading.value === undefined) {
        await expect(row).toContainText("Unavailable");
        continue;
      }
      await expect(row).toContainText(formatMultiple(reading.value));
      if (reading.date !== asOf) {
        await expect(row).toContainText(
          `as of ${formatLocalDate(reading.date as string)}`,
        );
      }
    }

    // All fifteen metrics, in their catalog units.
    expect(summary.fundamentals).toHaveLength(
      FUNDAMENTAL_METRIC_CATALOG.length,
    );
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const reading = summary.fundamentals.find((r) => r.id === entry.id);
      const row = page.getByTestId(`fundamental-${entry.id}`);
      await expect(row).toContainText(entry.label);
      if (reading?.value === undefined) {
        await expect(row).toContainText("Unavailable");
      } else {
        await expect(row).toContainText(
          formatFundamentalValue(reading.value, entry.unit),
        );
      }
    }

    // Exactly EMA 50D, EMA 200D and RSI 14D.
    const technicals = card(page, "Technicals");
    await expect(technicals.locator("dt")).toHaveText([
      "EMA 50D",
      "EMA 200D",
      "RSI 14D",
    ]);
    for (const reading of summary.technicals) {
      if (reading.value === undefined) {
        continue;
      }
      await expect(page.getByTestId(`technical-${reading.id}`)).toContainText(
        reading.id === "RSI_14D"
          ? formatOscillator(reading.value)
          : formatMoney(reading.value, summary.security.currency),
      );
    }

    // The header's close is the summary's newest bar.
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
    ).toContainText(summary.security.name);
    await expect(
      page.getByText(`At close · ${formatLocalDate(asOf as string)}`).first(),
    ).toBeVisible();

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("renders the cards while the chart is held, below the chart's own placeholder", async ({
    page,
  }) => {
    const release = await hold(page, CHART);
    await page.goto(`/stocks/${QA_SYMBOL}`);

    // The route's ticker is the heading at once; the cards render without the chart.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      QA_SYMBOL,
    );
    await expect(page.getByTestId("stock-research")).toBeVisible();
    await expect(page.getByTestId("price-history-loading")).toBeVisible();
    await expect(priceChart(page)).toHaveCount(0);
    // Visual order is not network order: the chart's place stays above the cards.
    const placeholder = await page
      .getByTestId("price-history-loading")
      .boundingBox();
    const research = await page.getByTestId("stock-research").boundingBox();
    expect(placeholder!.y + placeholder!.height).toBeLessThanOrEqual(
      research!.y,
    );
    const researchTop = research!.y;

    release();
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    // The cards did not move when the chart arrived in its reserved place.
    const after = await page.getByTestId("stock-research").boundingBox();
    expect(Math.abs(after!.y - researchTop)).toBeLessThanOrEqual(40);
  });

  test("renders the chart while the summary is held, with the cards still loading", async ({
    page,
  }) => {
    const release = await hold(page, SUMMARY);
    await page.goto(`/stocks/${QA_SYMBOL}`);

    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    await expect(page.getByTestId("stock-research-loading")).toBeVisible();
    // The header does not wait for the summary either: the chart's window carries the identity.
    await expect(page.getByRole("heading", { level: 1 })).not.toContainText(
      "Loading company details",
    );

    release();
    await expect(page.getByTestId("stock-research")).toBeVisible();
  });

  test("keeps a chart failure local and retries the chart alone", async ({
    page,
  }) => {
    let failed = false;
    await page.route(CHART, async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: 503, message: "unavailable" }),
        });
        return;
      }
      await route.continue();
    });
    const summaryRequests: string[] = [];
    page.on("request", (request) => {
      if (SUMMARY.test(request.url())) {
        summaryRequests.push(request.url());
      }
    });
    await page.goto(`/stocks/${QA_SYMBOL}`);

    const failure = page.getByTestId("price-history-error");
    await expect(failure).toContainText("The price chart could not be loaded.");
    await expect(page.getByTestId("stock-research")).toBeVisible();
    await expect(page.getByTestId("stock-load-error")).toHaveCount(0);

    await failure.getByRole("button", { name: "Try again" }).click();
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    expect(summaryRequests).toHaveLength(1);
  });

  test("keeps a summary failure local and retries the summary alone", async ({
    page,
  }) => {
    let failed = false;
    await page.route(SUMMARY, async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ statusCode: 503, message: "unavailable" }),
        });
        return;
      }
      await route.continue();
    });
    const chartRequests: string[] = [];
    page.on("request", (request) => {
      if (CHART.test(request.url())) {
        chartRequests.push(request.url());
      }
    });
    await page.goto(`/stocks/${QA_SYMBOL}`);

    const failure = page.getByTestId("stock-summary-error");
    await expect(failure).toBeVisible();
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");

    await failure.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("stock-research")).toBeVisible();
    expect(chartRequests).toHaveLength(1);
  });

  test("puts a card's ratio and metric on the chart, one request each, and the Indicators control agrees", async ({
    page,
  }) => {
    const issues = watchForIssues(page);
    const seriesRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.endsWith("/valuation-ratios/daily") ||
        path.endsWith("/fundamentals/daily")
      ) {
        seriesRequests.push(request.url());
      }
    });
    await page.goto(`/stocks/${QA_SYMBOL}`);
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    await expect(page.getByTestId("stock-research")).toBeVisible();

    const pb = page.getByTestId("valuation-ratio-PRICE_TO_BOOK");
    await pb.click();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-valuation",
      "PRICE_TO_BOOK",
    );
    await expect(pb).toHaveAttribute("aria-current", "true");
    await expect(pb).toContainText("On chart");
    // The chart was brought into view (smoothly, so wait for the scroll to settle).
    const chartTitle = page.getByRole("heading", {
      level: 2,
      name: "Price history",
    });
    await expect
      .poll(async () => {
        const box = await chartTitle.boundingBox();
        return box !== null && box.y >= 0 && box.y < DESKTOP.height / 2;
      })
      .toBe(true);

    // Pressing it again asks for nothing.
    await pb.click();
    await page.getByTestId("fundamental-ROIC_TTM").click();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental",
      "ROIC_TTM",
    );
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-valuation",
      "PRICE_TO_BOOK",
    );
    expect(
      seriesRequests.map(
        (url) =>
          new URL(url).searchParams.get("ratio") ??
          new URL(url).searchParams.get("metric"),
      ),
    ).toEqual(["PRICE_TO_BOOK", "ROIC_TTM"]);

    await page.getByTestId("indicators-trigger").click();
    const panel = page.getByTestId("indicators-panel");
    await expect(
      panel
        .getByTestId("valuation-section")
        .getByRole("radio", { name: "P/B", exact: true }),
    ).toBeChecked();
    await expect(
      panel
        .getByTestId("fundamentals-section")
        .getByRole("radio", { name: "ROIC TTM", exact: true }),
    ).toBeChecked();

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(issues.failedRequests).toEqual([]);
  });

  test("moves through each radio group with the keyboard, across the Fundamentals categories", async ({
    page,
  }) => {
    await page.goto(`/stocks/${QA_SYMBOL}`);
    await expect(chartWrapper(page)).toHaveAttribute("data-loading", "false");
    await page.getByTestId("indicators-trigger").click();
    const panel = page.getByTestId("indicators-panel");

    const none = panel
      .getByTestId("valuation-section")
      .getByRole("radio", { name: "None" });
    await none.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      panel
        .getByTestId("valuation-section")
        .getByRole("radio", { name: "P/E", exact: true }),
    ).toBeChecked();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-valuation",
      "PRICE_TO_EARNINGS_TTM",
    );

    // Tab leaves the valuation group for the one Fundamentals group; the arrow keys cross from
    // Growth into Profitability without a second tab stop.
    await page.keyboard.press("Tab");
    await expect(
      panel.getByTestId("fundamentals-section").getByRole("radio", {
        name: "None",
      }),
    ).toBeFocused();
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(
      panel
        .getByTestId("fundamentals-section")
        .getByRole("radio", { name: "Gross Margin TTM", exact: true }),
    ).toBeChecked();
    await expect(chartWrapper(page)).toHaveAttribute(
      "data-fundamental",
      "GROSS_MARGIN_TTM",
    );
    // The overlays are still checkboxes, and Escape closes and returns focus.
    await expect(panel.getByRole("checkbox").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("indicators-trigger")).toBeFocused();
  });

  test("shows the not-found state for a symbol outside the catalog", async ({
    page,
  }) => {
    await page.goto("/stocks/NOTASTOCK1");
    await expect(page.getByTestId("stock-not-found")).toBeVisible();
    await expect(page.getByTestId("stock-research")).toHaveCount(0);
  });
});
