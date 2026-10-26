import {
  newYorkDate,
  type BacktestRunDetailResponse,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { waitForRunsToSettle } from "../utils/backtests";
import { apiBaseUrl } from "../utils/entitlements";
import {
  annualHeatmapTexts,
  closeReaderContext,
  enableShareThroughDialog,
  expectNoHorizontalScroll,
  fmpJournal,
  metricTexts,
  openShareDialog,
  readShare,
  readerContext,
  revokeShareIfPresent,
  revokeShareThroughDialog,
  SHARE_URL,
  shareTokenOf,
} from "../utils/sharing";

/**
 * Public backtest sharing, end to end, for PRO_USER as the owner
 * (`docs/decisions/backtest-sharing-v1.md`).
 *
 * The owner shares a run they just completed; a Guest, a Free user and a Starter user each open
 * the link in their own browser; the owner revokes it and shares again. Along the way: the public
 * page shows the owner's own figures and the interactive chart; nothing private reaches its HTML;
 * a crawler without JavaScript reads Open Graph tags from the real result; the preview image is a
 * PNG; no reader can control the link; and no public view makes a provider request.
 *
 * Preconditions are the backtest suite's: the hermetic stack, `pnpm test:personas:seed` (which
 * seeds `QATEST1` with price history and the benchmark) and a running worker. The strategy and
 * list are created through the API with the owner's own session and removed afterwards; the run
 * is a durable record and stays, unshared.
 */

const QA_SYMBOL = "QATEST1";
const STRATEGY_NAME = "E2E sharing strategy (private)";
const LIST_NAME = "E2E sharing list (private)";
/** One BUY and one SELL condition: all the public report may say about the strategy is "2". */
const RULE_COUNT = 2;

/** Inside the seeded 160-week window, whichever day the suite runs on. */
function seededPeriodStart(): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 2 * 365);
  return start.toISOString().slice(0, 10);
}

test.describe.configure({ mode: "serial" });

test.describe("sharing a completed backtest", () => {
  let runId = "";
  let strategyId = "";
  let listId = "";
  let shareUrl = "";
  let ownerMetrics: Record<string, string> = {};
  let ownerRunLabel = "";
  let ownerHeatmap: Awaited<ReturnType<typeof annualHeatmapTexts>> = {
    years: [],
    strategy: [],
    benchmark: [],
  };

  async function api(
    page: Page,
    method: "GET" | "POST" | "DELETE",
    path: string,
    data?: unknown,
  ) {
    return page.request.fetch(`${apiBaseUrl()}${path}`, {
      method,
      ...(data === undefined ? {} : { data }),
    });
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(150_000);
    const context = await readerContext(browser, "PRO_USER");
    const page = await context.newPage();
    try {
      const search = await api(page, "GET", `/stocks/search?q=${QA_SYMBOL}`);
      const securities = (await search.json()) as StockSearchResultResponse[];
      const security = securities.find((entry) => entry.symbol === QA_SYMBOL);
      test.skip(
        !security,
        `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\` first.`,
      );

      const strategy = await api(page, "POST", "/strategies", {
        name: STRATEGY_NAME,
        definition: {
          schemaVersion: 2,
          buyLevels: [
            {
              id: "share-buy",
              percentage: 100,
              signal: {
                conditions: [
                  {
                    id: "share-buy-1",
                    metric: { kind: "PRICE" },
                    operator: "IS_ABOVE",
                    value: { kind: "SERIES", seriesId: "SMA_50D" },
                  },
                ],
              },
            },
          ],
          sellLevels: [
            {
              id: "share-sell",
              percentage: 50,
              signal: {
                conditions: [
                  {
                    id: "share-sell-1",
                    metric: { kind: "PRICE" },
                    operator: "IS_BELOW",
                    value: { kind: "SERIES", seriesId: "SMA_50D" },
                  },
                ],
              },
            },
          ],
        },
      });
      expect(strategy.status(), await strategy.text()).toBe(201);
      strategyId = ((await strategy.json()) as { id: string }).id;

      const list = await api(page, "POST", "/lists", {
        name: LIST_NAME,
        securityIds: [security?.id],
      });
      expect(list.status(), await list.text()).toBe(201);
      listId = ((await list.json()) as { id: string }).id;

      const submitted = await api(page, "POST", "/backtests", {
        strategyId,
        stockListId: listId,
        startDate: seededPeriodStart(),
        endDate: newYorkDate(new Date()),
        initialCapital: 25_000,
        // Contributions are what make the funded benchmark line differ from a growth index.
        monthlyContribution: 500,
        maximumPositions: 5,
      });
      expect(submitted.status(), await submitted.text()).toBe(202);
      runId = ((await submitted.json()) as BacktestRunDetailResponse).id;
      await waitForRunsToSettle(page, [runId]);
      const run = (await (
        await api(page, "GET", `/backtests/${runId}`)
      ).json()) as BacktestRunDetailResponse;
      expect(run.status, "the shared run completes").toBe("COMPLETED");
    } finally {
      await closeReaderContext(context);
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await readerContext(browser, "PRO_USER");
    const page = await context.newPage();
    if (runId) {
      await revokeShareIfPresent(page.request, runId);
    }
    if (strategyId) {
      await api(page, "DELETE", `/strategies/${strategyId}`).catch(() => null);
    }
    if (listId) {
      await api(page, "DELETE", `/lists/${listId}`).catch(() => null);
    }
    await context.close();
  });

  test("the owner shares the run and copies its public link", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const dialog = await openShareDialog(page, runId);
    await expect(page.getByTestId("backtest-share")).toHaveAttribute(
      "data-shared",
      "false",
    );
    await expect(dialog.getByTestId("backtest-share-privacy")).toContainText(
      "trade log always stay private",
    );
    await expect(dialog.getByTestId("backtest-share-url")).toHaveCount(0);

    await dialog.getByTestId("backtest-share-enable").click();
    const field = dialog.getByTestId("backtest-share-url");
    await expect(field).toHaveValue(SHARE_URL);
    shareUrl = await field.inputValue();
    expect(shareUrl).not.toContain(runId);

    await dialog.getByTestId("backtest-share-copy").click();
    await expect(dialog.getByTestId("backtest-share-copy")).toHaveText(
      "Copied",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      shareUrl,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("backtest-share")).toHaveText("Shared");

    // Sharing again reuses the active link rather than minting another.
    expect(await enableShareThroughDialog(page, runId)).toBe(shareUrl);
    expect((await readShare(page, runId)).url).toBe(shareUrl);

    // The owner's own page is unchanged: the rerun action and the trade log are still there.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("backtest-edit-and-rerun")).toBeVisible();
    await expect(page.getByRole("region", { name: "Trade log" })).toBeVisible();
    ownerMetrics = await metricTexts(page);
    expect(Object.keys(ownerMetrics)).toHaveLength(8);
    ownerRunLabel =
      (await page.getByTestId("backtest-run-title").textContent())?.trim() ??
      "";
    expect(ownerRunLabel).toMatch(/^Run #\d{4,}$/);
    ownerHeatmap = await annualHeatmapTexts(page);
    expect(ownerHeatmap.years.length).toBeGreaterThan(0);
  });

  test("a Guest reads the report: the owner's figures, the live chart, nothing private, no provider request", async ({
    browser,
  }) => {
    const before = await fmpJournal();
    const guest = await readerContext(browser, "GUEST");
    const page = await guest.newPage();
    const response = await page.goto(shareUrl);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId("shared-backtest")).toBeVisible();
    // Titled by the owner page's own Run ID — never the run's UUID — and said to be shared.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      ownerRunLabel,
    );
    await expect(page.getByTestId("shared-backtest-metadata")).toContainText(
      "Shared backtest report",
    );
    await expect(page.getByTestId("shared-backtest-badge")).toHaveText(
      "Read-only",
    );
    // The interactive Lightweight Charts chart, with the Strategy and benchmark drawn.
    const chart = page.getByTestId("backtest-chart");
    await expect(chart).toBeVisible();
    await expect(chart.locator("canvas").first()).toBeVisible();
    expect(
      Number(await chart.getAttribute("data-strategy-points")),
    ).toBeGreaterThan(1);
    expect(
      Number(await chart.getAttribute("data-series-count")),
    ).toBeGreaterThanOrEqual(2);

    // The same eight figures, formatted the same way, as on the owner's own page — beside the
    // chart in the same 70/30 overview at this 1,280px desktop width.
    expect(await metricTexts(page)).toEqual(ownerMetrics);
    const chartBox = await page.getByTestId("backtest-chart").boundingBox();
    const resultsBox = await page.getByTestId("backtest-results").boundingBox();
    expect(chartBox && resultsBox).toBeTruthy();
    if (chartBox && resultsBox) {
      expect(resultsBox.x).toBeGreaterThanOrEqual(
        chartBox.x + chartBox.width - 1,
      );
      expect(Math.abs(resultsBox.y - chartBox.y)).toBeLessThan(24);
    }
    // And each year as the same Strategy vs benchmark heatmap.
    expect(await annualHeatmapTexts(page)).toEqual(ownerHeatmap);
    await expect(page.getByTestId("shared-backtest-security-count")).toHaveText(
      "1",
    );
    await expect(page.getByTestId("shared-backtest-rule-count")).toHaveText(
      String(RULE_COUNT),
    );
    await expect(page.getByTestId("shared-backtest-run-id")).toHaveText(
      ownerRunLabel,
    );

    // No trade log, no owner action, no link into the private strategy or list.
    for (const testId of [
      "backtest-trades",
      "backtest-share",
      "backtest-edit-and-rerun",
      "run-configuration",
    ]) {
      await expect(page.getByTestId(testId), testId).toHaveCount(0);
    }
    await expect(page.getByRole("region", { name: "Trade log" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("heading", { name: /trade/i })).toHaveCount(0);
    await expect(page.locator('a[href^="/strategies/"]')).toHaveCount(0);
    await expect(page.locator('a[href^="/lists/"]')).toHaveCount(0);

    // Not in the rendered page, and not in the HTML or the serialized payload either.
    const html = await (await page.request.get(shareUrl)).text();
    for (const secret of [
      STRATEGY_NAME,
      LIST_NAME,
      QA_SYMBOL,
      strategyId,
      listId,
      // The run's UUID: the public page names it by its Run ID only.
      runId,
      "share-buy",
      "share-sell",
      "SMA_50D",
      "IS_ABOVE",
      // The rules in words: the owner has not published the description.
      "SMA 50D",
      "is above",
    ]) {
      expect(html, `served HTML contains ${secret}`).not.toContain(secret);
      expect(await page.content(), `page contains ${secret}`).not.toContain(
        secret,
      );
    }

    // The call to action is the visitor's own next step, through registration.
    await expect(page.getByTestId("shared-backtest-cta")).toHaveAttribute(
      "href",
      "/register?next=%2Fbacktests%2Fnew",
    );

    // Readable on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("backtest-chart")).toBeVisible();
    await expectNoHorizontalScroll(page);
    // Stacked there: the results follow the chart rather than sit beside it.
    const phoneChart = await page.getByTestId("backtest-chart").boundingBox();
    const phoneResults = await page
      .getByTestId("backtest-results")
      .boundingBox();
    if (phoneChart && phoneResults) {
      expect(phoneResults.y).toBeGreaterThanOrEqual(
        phoneChart.y + phoneChart.height - 1,
      );
    }

    const after = await fmpJournal(before.last);
    expect(
      after.entries.map((entry) => entry.detail),
      "a public view made a provider request",
    ).toEqual([]);
    await closeReaderContext(guest);
  });

  test("a link-preview crawler reads Open Graph tags and a PNG without JavaScript", async ({
    playwright,
  }) => {
    const crawler = await playwright.request.newContext({
      userAgent: "WhatsApp/2.23.20.0",
    });
    const html = await (await crawler.get(shareUrl)).text();
    const head = html.slice(0, html.indexOf("</head>"));
    const meta = (key: string) =>
      new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(
        head,
      )?.[1];

    expect(meta("og:type")).toBe("website");
    expect(meta("og:url")).toBe(shareUrl);
    expect(meta("og:title")).toMatch(
      /^-?[\d,]+\.\d% (Annualized|Total return)( vs -?[\d,]+\.\d% .+)? \| FactorSage$/,
    );
    expect(meta("og:description")).toMatch(
      new RegExp(
        `^\\d+-(year|month) backtest · 1 security · ${RULE_COUNT} strategy rules$`,
      ),
    );
    expect(meta("og:image")).toBe(`${shareUrl}/preview.png`);
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("robots")).toContain("noindex");
    expect(head).not.toContain(STRATEGY_NAME);

    const image = await crawler.get(`${shareUrl}/preview.png`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    const bytes = await image.body();
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    await crawler.dispose();
  });

  test("Free and Starter users read the same report, and are offered New Backtest", async ({
    browser,
  }) => {
    for (const persona of ["FREE_USER", "STARTER_USER"] as const) {
      const context = await readerContext(browser, persona);
      const page = await context.newPage();
      expect((await page.goto(shareUrl))?.status(), persona).toBe(200);
      await expect(page.getByTestId("shared-backtest"), persona).toBeVisible();
      expect(await metricTexts(page), persona).toEqual(ownerMetrics);
      await expect(
        page.getByTestId("shared-backtest-cta"),
        persona,
      ).toHaveAttribute("href", "/backtests/new");
      await closeReaderContext(context);
    }
  });

  test("nobody but the owner can control the link, and the private run stays private", async ({
    browser,
  }) => {
    const context = await readerContext(browser, "STARTER_USER");
    const page = await context.newPage();
    const share = `${apiBaseUrl()}/backtests/${runId}/share`;
    expect((await page.request.get(share)).status()).toBe(404);
    expect((await page.request.put(share, { data: {} })).status()).toBe(404);
    expect((await page.request.delete(share)).status()).toBe(404);
    expect(
      (await page.request.get(`${apiBaseUrl()}/backtests/${runId}`)).status(),
    ).toBe(404);
    expect(
      (
        await page.request.get(`${apiBaseUrl()}/backtests/${runId}/trades`)
      ).status(),
    ).toBe(404);
    // The link still works: nothing a non-owner did reached it.
    expect((await page.goto(shareUrl))?.status()).toBe(200);
    await closeReaderContext(context);
  });

  test("revoking stops the link at once, and sharing again creates a new one", async ({
    page,
    browser,
  }) => {
    await revokeShareThroughDialog(page, runId);
    expect((await readShare(page, runId)).shared).toBe(false);

    const guest = await readerContext(browser, "GUEST");
    const reader = await guest.newPage();
    expect((await reader.goto(shareUrl))?.status()).toBe(404);
    await expect(reader.getByTestId("shared-backtest-not-found")).toBeVisible();
    expect((await reader.request.get(`${shareUrl}/preview.png`)).status()).toBe(
      404,
    );
    expect(
      (
        await reader.request.get(
          `${apiBaseUrl()}/shared-backtests/${shareTokenOf(shareUrl)}`,
        )
      ).status(),
    ).toBe(404);

    await page.keyboard.press("Escape");
    const renewed = await enableShareThroughDialog(page, runId);
    expect(renewed).not.toBe(shareUrl);
    expect((await reader.goto(renewed))?.status()).toBe(200);
    expect((await reader.goto(shareUrl))?.status()).toBe(404);
    await closeReaderContext(guest);
  });
});
