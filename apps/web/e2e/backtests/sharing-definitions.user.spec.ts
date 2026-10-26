import {
  newYorkDate,
  type BacktestRunDetailResponse,
  type StockListSummaryResponse,
  type StockSearchResultResponse,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { waitForRunsToSettle } from "../utils/backtests";
import { apiBaseUrl } from "../utils/entitlements";
import {
  closeReaderContext,
  enableShareThroughDialog,
  expectNoHorizontalScroll,
  openShareDialog,
  readerContext,
  readShare,
  revokeShareIfPresent,
  SHARE_URL,
} from "../utils/sharing";

/**
 * What a shared backtest says about its Strategy and List, end to end, for PRO_USER as the owner
 * (`docs/decisions/canonical-definitions-v1.md`).
 *
 * Two runs: one of the QA built-in strategy over the QA built-in list, whose official descriptions
 * are public without anybody's opt-in; and one of the owner's own strategy and list, whose
 * descriptions stay private until the owner ticks the option in the Share dialog — which says what
 * that reveals — and private again when they untick it. Throughout: the report names a built-in by
 * its official name and a customer's content by its origin alone, never shows a security, the
 * owner's names or the trade log, and keeps its Open Graph preview.
 *
 * Preconditions are the sharing suite's: the hermetic stack, `pnpm test:personas:seed` (the QA
 * built-ins and `QATEST1`'s history) and a running worker.
 */

const QA_SYMBOL = "QATEST1";
const QA_BUILT_IN_STRATEGY = "QA Built-in Trend";
const QA_BUILT_IN_LIST = "QA Built-in Leaders";
const STRATEGY_NAME = "E2E described strategy (private)";
const LIST_NAME = "E2E described list (private)";

function seededPeriodStart(): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 2 * 365);
  return start.toISOString().slice(0, 10);
}

test.describe.configure({ mode: "serial" });

test.describe("a shared backtest's strategy and list", () => {
  let builtInRunId = "";
  let customRunId = "";
  let strategyId = "";
  let listId = "";
  let customShareUrl = "";

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

  async function submit(
    page: Page,
    strategy: string,
    list: string,
  ): Promise<string> {
    const submitted = await api(page, "POST", "/backtests", {
      strategyId: strategy,
      stockListId: list,
      startDate: seededPeriodStart(),
      endDate: newYorkDate(new Date()),
      initialCapital: 25_000,
      monthlyContribution: 0,
      maximumPositions: 5,
    });
    expect(submitted.status(), await submitted.text()).toBe(202);
    return ((await submitted.json()) as BacktestRunDetailResponse).id;
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await readerContext(browser, "PRO_USER");
    const page = await context.newPage();
    try {
      const strategies = (await (
        await api(page, "GET", "/strategies")
      ).json()) as StrategySummaryResponse[];
      const lists = (await (
        await api(page, "GET", "/lists")
      ).json()) as StockListSummaryResponse[];
      const builtInStrategy = strategies.find(
        (strategy) =>
          strategy.name === QA_BUILT_IN_STRATEGY &&
          strategy.ownership === "SYSTEM",
      );
      const builtInList = lists.find(
        (list) => list.name === QA_BUILT_IN_LIST && list.ownership === "SYSTEM",
      );
      test.skip(
        !builtInStrategy || !builtInList,
        "The QA built-ins are missing. Run `pnpm test:builtins:seed`.",
      );
      const search = await api(page, "GET", `/stocks/search?q=${QA_SYMBOL}`);
      const security = (
        (await search.json()) as StockSearchResultResponse[]
      ).find((entry) => entry.symbol === QA_SYMBOL);
      test.skip(
        !security,
        `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\`.`,
      );

      const strategy = await api(page, "POST", "/strategies", {
        name: STRATEGY_NAME,
        definition: {
          schemaVersion: 2,
          buyLevels: [
            {
              id: "described-buy",
              percentage: 100,
              signal: {
                conditions: [
                  {
                    id: "described-buy-1",
                    metric: { kind: "PRICE" },
                    operator: "IS_ABOVE",
                    value: { kind: "SERIES", seriesId: "SMA_50D" },
                  },
                ],
              },
            },
          ],
          sellLevels: [],
          finalExit: {
            id: "described-exit",
            rules: [
              {
                id: "described-exit-1",
                signal: {
                  conditions: [
                    {
                      id: "described-exit-1-1",
                      metric: { kind: "PRICE" },
                      operator: "IS_BELOW",
                      value: { kind: "SERIES", seriesId: "EMA_200D" },
                    },
                  ],
                },
              },
            ],
          },
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

      // A plan runs one backtest at a time, so the two runs go one after the other.
      builtInRunId = await submit(
        page,
        builtInStrategy?.id ?? "",
        builtInList?.id ?? "",
      );
      await waitForRunsToSettle(page, [builtInRunId]);
      customRunId = await submit(page, strategyId, listId);
      await waitForRunsToSettle(page, [customRunId]);
      for (const runId of [builtInRunId, customRunId]) {
        const run = (await (
          await api(page, "GET", `/backtests/${runId}`)
        ).json()) as BacktestRunDetailResponse;
        expect(run.status, "the run completes").toBe("COMPLETED");
      }
    } finally {
      await closeReaderContext(context);
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await readerContext(browser, "PRO_USER");
    const page = await context.newPage();
    for (const runId of [builtInRunId, customRunId]) {
      if (runId) {
        await revokeShareIfPresent(page.request, runId);
      }
    }
    if (strategyId) {
      await api(page, "DELETE", `/strategies/${strategyId}`).catch(() => null);
    }
    if (listId) {
      await api(page, "DELETE", `/lists/${listId}`).catch(() => null);
    }
    await context.close();
  });

  test("a built-in run is described publicly by name, with no choice to make", async ({
    page,
    browser,
  }) => {
    const dialog = await openShareDialog(page, builtInRunId);
    const strategy = dialog.getByTestId("backtest-share-definition-strategy");
    await expect(strategy).toHaveAttribute("data-origin", "built_in");
    await expect(strategy).toContainText(
      "Built-in · Official FactorSage Strategy",
    );
    await expect(strategy).toContainText(
      "is public: it is official FactorSage content",
    );
    await expect(dialog.getByTestId("backtest-share-publish")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const shareUrl = await enableShareThroughDialog(page, builtInRunId);

    const guest = await readerContext(browser, "GUEST");
    const reader = await guest.newPage();
    expect((await reader.goto(shareUrl))?.status()).toBe(200);
    const section = reader.getByTestId("shared-backtest-definitions");
    await expect(section).toBeVisible();
    await expect(
      reader.getByTestId("shared-backtest-strategy").getByRole("heading"),
    ).toHaveText(`Strategy — ${QA_BUILT_IN_STRATEGY}`);
    await expect(
      reader.getByTestId("shared-backtest-strategy-provenance"),
    ).toHaveText("Built-in · Official FactorSage Strategy");
    await expect(
      reader.getByTestId("shared-backtest-strategy-short"),
    ).toContainText("Buys when SMA 50D is above SMA 200D");
    await expect(
      reader.getByTestId("shared-backtest-list").getByRole("heading"),
    ).toHaveText(`List — ${QA_BUILT_IN_LIST}`);
    await expect(
      reader.getByTestId("shared-backtest-list-provenance"),
    ).toHaveText("Built-in · Official FactorSage List");
    await expect(
      reader.getByTestId("shared-backtest-list-short"),
    ).toContainText("security");
    // Still a results page: no trade log, no security, a phone-width layout.
    await expect(reader.getByRole("region", { name: "Trade log" })).toHaveCount(
      0,
    );
    expect(await (await reader.request.get(shareUrl)).text()).not.toContain(
      QA_SYMBOL,
    );
    await reader.setViewportSize({ width: 390, height: 844 });
    await expect(section).toBeVisible();
    await expectNoHorizontalScroll(reader);
    await closeReaderContext(guest);
  });

  test("the owner's own strategy and list stay private until the owner publishes them", async ({
    page,
    browser,
  }) => {
    const dialog = await openShareDialog(page, customRunId);
    await expect(
      dialog.getByTestId("backtest-share-definition-strategy"),
    ).toHaveAttribute("data-origin", "custom");
    await expect(
      dialog.getByTestId("backtest-share-definition-strategy"),
    ).toContainText("Buys when Price is above SMA 50D.");
    const option = dialog.getByTestId("backtest-share-publish");
    await expect(option).not.toBeChecked();
    await expect(
      dialog.getByTestId("backtest-share-publish-warning"),
    ).toContainText(
      "reveals your strategy's conditions — the metrics, operators and thresholds it uses",
    );
    await dialog.getByTestId("backtest-share-enable").click();
    await expect(dialog.getByTestId("backtest-share-url")).toHaveValue(
      SHARE_URL,
    );
    customShareUrl = await dialog
      .getByTestId("backtest-share-url")
      .inputValue();
    expect((await readShare(page, customRunId)).publishDescriptions).toBe(
      false,
    );

    const guest = await readerContext(browser, "GUEST");
    const reader = await guest.newPage();
    expect((await reader.goto(customShareUrl))?.status()).toBe(200);
    await expect(
      reader.getByTestId("shared-backtest-strategy-provenance"),
    ).toHaveText("Custom");
    await expect(
      reader.getByTestId("shared-backtest-strategy-withheld"),
    ).toHaveText("The owner keeps this strategy's rules private.");
    await expect(
      reader.getByTestId("shared-backtest-list-provenance"),
    ).toHaveText("Custom");
    const privateHtml = await (await reader.request.get(customShareUrl)).text();
    for (const secret of [
      STRATEGY_NAME,
      LIST_NAME,
      QA_SYMBOL,
      strategyId,
      listId,
      "SMA 50D",
      "is above",
    ]) {
      expect(privateHtml, `served HTML contains ${secret}`).not.toContain(
        secret,
      );
    }

    // Published: the rules in words, and still nothing else.
    await option.check();
    await expect(
      dialog.getByTestId("backtest-share-definition-strategy"),
    ).toContainText("is published on the report");
    expect((await readShare(page, customRunId)).publishDescriptions).toBe(true);
    await reader.reload();
    await expect(
      reader.getByTestId("shared-backtest-strategy-short"),
    ).toHaveText(
      "Buys when Price is above SMA 50D. Closes the position when Price is below EMA 200D.",
    );
    await expect(
      reader.getByTestId("shared-backtest-strategy-detailed"),
    ).toContainText(
      "FINAL EXIT: closes the whole remaining position when Price is below EMA 200D.",
    );
    await expect(reader.getByTestId("shared-backtest-list-short")).toHaveText(
      "1 security, each eligible to buy on any date.",
    );
    const publishedHtml = await (
      await reader.request.get(customShareUrl)
    ).text();
    for (const secret of [
      STRATEGY_NAME,
      LIST_NAME,
      QA_SYMBOL,
      strategyId,
      listId,
      "SMA_50D",
      "IS_ABOVE",
    ]) {
      expect(publishedHtml, `served HTML contains ${secret}`).not.toContain(
        secret,
      );
    }
    await expect(reader.getByRole("region", { name: "Trade log" })).toHaveCount(
      0,
    );

    // And private again.
    await option.uncheck();
    await expect(
      dialog.getByTestId("backtest-share-definition-strategy"),
    ).toContainText("stays private unless you publish it");
    await reader.reload();
    await expect(
      reader.getByTestId("shared-backtest-strategy-withheld"),
    ).toBeVisible();
    await closeReaderContext(guest);
  });

  test("the link preview is unchanged: Open Graph tags and a PNG, with no rule in them", async ({
    playwright,
  }) => {
    const crawler = await playwright.request.newContext({
      userAgent: "WhatsApp/2.23.20.0",
    });
    const html = await (await crawler.get(customShareUrl)).text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('property="og:title"');
    expect(head).toContain(`content="${customShareUrl}/preview.png"`);
    expect(head).not.toContain("SMA 50D");
    expect(head).not.toContain(STRATEGY_NAME);
    const image = await crawler.get(`${customShareUrl}/preview.png`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    await crawler.dispose();
  });
});
