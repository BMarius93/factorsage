import {
  STRATEGY_SCHEMA_VERSION,
  type BacktestRunDetailResponse,
  type BacktestTradePageResponse,
  type BacktestTradeResponse,
  type MonitorDetailResponse,
  type StrategyCondition,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { isTerminalStatus, RUN_SETTLE_TIMEOUT_MS } from "../utils/backtests";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * ETF-sourced Conditions evaluated by the real stack, for PRO_USER: the API pins each ETF's series
 * at submission, the worker reads the stored ETF history out of PostgreSQL/Redis, computes its
 * technicals once per run and joins them onto the stock's sessions, and the run page says what
 * each fund could support (`ai/architecture/strategy-etf-conditions.md`).
 *
 * Every expectation is a fact of the seeded fixtures (`seed-qa-benchmark-data.ts`), not of the
 * engine: `XLK` only rises, so its Price is above its own 200-day average on every session; `XLE`
 * only falls, so it never is; the nineteen ETF fixtures begin on one known Monday, so a 200-week
 * average first exists exactly 200 weeks later; and `SP500` is seeded as the on-demand backtest
 * benchmark, without the floor-anchored coverage an ETF condition requires, so `SPY` reads as not
 * bootstrapped. The control is the same strategy without any ETF rule.
 *
 * Needs the seeded QA security, the worker (`pnpm dev:worker:e2e`) and the ETF fixtures
 * (`pnpm test:securities:seed`); it provisions its strategies, list and Monitor through the API
 * and removes them. Runs are immutable records and stay.
 */

const QA_SYMBOL = "QATEST1";

type Json = Record<string, unknown>;

const STOCK_PRICE_BELOW_EMA: StrategyCondition = {
  id: "c-stock",
  metric: { kind: "PRICE" },
  operator: "IS_BELOW",
  value: { kind: "SERIES", seriesId: "EMA_200D" },
};

function etfPriceAbove(
  code: "ETF_XLK" | "ETF_XLE",
  seriesId: "SMA_200D" | "SMA_200W",
): StrategyCondition {
  return {
    id: "c-etf",
    metric: { kind: "PRICE", source: { kind: "ETF", code } },
    operator: "IS_ABOVE",
    value: { kind: "SERIES", seriesId },
  };
}

const SPY_RSI_ABOVE_1: StrategyCondition = {
  id: "c-etf",
  metric: {
    kind: "OSCILLATOR",
    seriesId: "RSI_14D",
    source: { kind: "ETF", code: "SP500" },
  },
  operator: "IS_ABOVE",
  value: { kind: "NUMBER", value: 1 },
};

/** Comfortably inside the QA security's 160-week window, whichever day the suite runs on. */
function periodStart(): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 2 * 365);
  return start.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

async function post<T>(page: Page, path: string, data: Json): Promise<T> {
  const response = await page.request.post(`${apiBaseUrl()}${path}`, { data });
  expect(
    response.ok(),
    `POST ${path} answered ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function get<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${apiBaseUrl()}${path}`);
  expect(response.ok(), `GET ${path} answered ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

async function createStrategy(
  page: Page,
  name: string,
  conditions: readonly StrategyCondition[],
): Promise<string> {
  const strategy = await post<StrategyDetailResponse>(page, "/strategies", {
    name,
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "b1", percentage: 100, signal: { conditions } }],
      sellLevels: [],
    },
  });
  return strategy.id;
}

/** Submits one run and waits for it to settle: the persona has a single free concurrency slot. */
async function runBacktest(
  page: Page,
  strategyId: string,
  stockListId: string,
): Promise<{
  run: BacktestRunDetailResponse;
  strategyTrades: BacktestTradeResponse[];
}> {
  const submitted = await post<{ id: string }>(page, "/backtests", {
    strategyId,
    stockListId,
    startDate: periodStart(),
    endDate: today(),
    initialCapital: 25_000,
    monthlyContribution: 500,
    maximumPositions: 5,
  });
  let run: BacktestRunDetailResponse | undefined;
  await expect
    .poll(
      async () => {
        run = await get<BacktestRunDetailResponse>(
          page,
          `/backtests/${submitted.id}`,
        );
        return isTerminalStatus(run.status);
      },
      {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        intervals: [500, 1_000, 2_000],
        message: `Run ${submitted.id} did not settle. Is \`pnpm dev:worker:e2e\` running?`,
      },
    )
    .toBe(true);
  expect(run?.status, JSON.stringify(run?.failure ?? null)).toBe("COMPLETED");
  const trades = await get<BacktestTradePageResponse>(
    page,
    `/backtests/${submitted.id}/trades?pageSize=200`,
  );
  // One page holds the whole log, so "the strategy's trades" below really is all of them.
  expect(trades.pageCount).toBe(1);
  return {
    run: run as BacktestRunDetailResponse,
    strategyTrades: trades.items.filter((trade) => trade.source === "STRATEGY"),
  };
}

/** What makes two runs the same trades: when, what, and how much. */
function tradeFacts(trades: readonly BacktestTradeResponse[]) {
  return trades.map(({ date, action, symbol, shares, price, amount }) => ({
    date,
    action,
    symbol,
    shares,
    price,
    amount,
  }));
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("ETF conditions through a real backtest and Monitor", () => {
  const created: { strategies: string[]; lists: string[]; monitors: string[] } =
    { strategies: [], lists: [], monitors: [] };

  test.afterEach(async ({ page }) => {
    // Monitors first: a Strategy or List a Monitor still references cannot be deleted.
    for (const [path, ids] of [
      ["monitors", created.monitors],
      ["strategies", created.strategies],
      ["lists", created.lists],
    ] as const) {
      for (const id of ids.splice(0)) {
        await page.request
          .delete(`${apiBaseUrl()}/${path}/${id}`)
          .catch(() => {});
      }
    }
  });

  test("evaluates ETF rules on the ETF's own history, and says on the run what each fund could support", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto("/backtests");
    const search = await get<{ id: string; symbol: string }[]>(
      page,
      `/stocks/search?q=${QA_SYMBOL}`,
    );
    const security = search.find((row) => row.symbol === QA_SYMBOL);
    test.skip(
      !security,
      `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\` against this stack.`,
    );
    const stamp = Date.now();
    const list = await post<{ id: string }>(page, "/lists", {
      name: `E2E etf backtest list ${stamp}`,
      securityIds: [security!.id],
    });
    created.lists.push(list.id);

    const strategyOf = async (
      label: string,
      conditions: readonly StrategyCondition[],
    ) => {
      const id = await createStrategy(
        page,
        `E2E etf backtest ${label} ${stamp}`,
        conditions,
      );
      created.strategies.push(id);
      return runBacktest(page, id, list.id);
    };

    // The control: the stock rule alone. It must trade, or nothing below proves anything.
    const control = await strategyOf("control", [STOCK_PRICE_BELOW_EMA]);
    expect(control.strategyTrades.length).toBeGreaterThan(0);
    expect(control.run.result?.etfConditions).toBeUndefined();

    // + an ETF rule that holds on every session: exactly the control's trades, to the share.
    const alwaysTrue = await strategyOf("xlk", [
      STOCK_PRICE_BELOW_EMA,
      etfPriceAbove("ETF_XLK", "SMA_200D"),
    ]);
    expect(tradeFacts(alwaysTrue.strategyTrades)).toEqual(
      tradeFacts(control.strategyTrades),
    );
    const xlk = alwaysTrue.run.result?.etfConditions;
    expect(xlk).toHaveLength(1);
    expect(xlk?.[0]).toMatchObject({
      code: "ETF_XLK",
      ticker: "XLK",
      status: "READY",
      basisGeneration: 0,
    });
    const firstSession = xlk?.[0]?.firstSession as string;
    const latestSession = xlk?.[0]?.latestSession as string;
    expect(new Date(`${firstSession}T00:00:00.000Z`).getUTCDay()).toBe(1);
    // The fund's newest session is a completed one: never today's, and never after the stock's.
    expect(latestSession < today()).toBe(true);

    // + an ETF rule that never holds: the stock rule alone can no longer buy anything.
    const alwaysFalse = await strategyOf("xle", [
      STOCK_PRICE_BELOW_EMA,
      etfPriceAbove("ETF_XLE", "SMA_200D"),
    ]);
    expect(alwaysFalse.strategyTrades).toEqual([]);
    expect(alwaysFalse.run.result?.etfConditions?.[0]).toMatchObject({
      ticker: "XLE",
      status: "READY",
    });

    // + a 200-week average: not evaluable until 200 completed weeks of the fund exist, so nothing
    // is bought before the Monday 200 weeks after its first session — while the control, which has
    // no such rule, did buy before it.
    const first200w = addDays(firstSession, 200 * 7);
    const longWindow = await strategyOf("xlk 200w", [
      STOCK_PRICE_BELOW_EMA,
      etfPriceAbove("ETF_XLK", "SMA_200W"),
    ]);
    expect(longWindow.strategyTrades.length).toBeGreaterThan(0);
    for (const trade of longWindow.strategyTrades) {
      expect(trade.date >= first200w, `${trade.date} >= ${first200w}`).toBe(
        true,
      );
    }
    expect(
      control.strategyTrades.some((trade) => trade.date < first200w),
    ).toBe(true);

    // + a fund whose history was never bootstrapped: the rule is never evaluable, nothing is
    // bought, and the run says why instead of looking like a strategy that found nothing.
    const unavailable = await strategyOf("spy", [
      STOCK_PRICE_BELOW_EMA,
      SPY_RSI_ABOVE_1,
    ]);
    expect(unavailable.strategyTrades).toEqual([]);
    expect(unavailable.run.result?.etfConditions).toEqual([
      { code: "SP500", ticker: "SPY", status: "NOT_BOOTSTRAPPED" },
    ]);

    // The run page: a fund that was read is a plain note beside the results …
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/backtests/${alwaysTrue.run.id}`);
    const notice = page.getByTestId("backtest-etf-conditions");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText("ETF conditions");
    const row = notice.getByTestId("backtest-etf-condition");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-ticker", "XLK");
    await expect(row).toHaveAttribute("data-ready", "true");
    await expect(row).toContainText("XLK — Read from its first session");
    await expect(notice).toContainText(
      "An ETF condition is decided on the ETF's own completed sessions.",
    );
    // … and every trade's reason names the fund the rule read.
    await expect(
      page
        .getByTestId("backtest-trade-row")
        .filter({ hasText: "XLK · Price is above SMA 200D" })
        .first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(notice).toBeVisible();
    await expectNoHorizontalScroll(page);

    // … a fund that could not be read is a warning that says what that did to the run …
    await page.goto(`/backtests/${unavailable.run.id}`);
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText(
      "The ETF conditions could not be evaluated",
    );
    await expect(row).toHaveAttribute("data-ticker", "SPY");
    await expect(row).toHaveAttribute("data-ready", "false");
    await expect(row).toContainText(
      "SPY — Its market history has not been loaded yet, so no condition reading it could be evaluated.",
    );
    await expect(notice).toContainText(
      "A condition that cannot be evaluated never matches, so a signal that needs it did not fire in this run.",
    );
    await expectNoHorizontalScroll(page);

    // … and a run whose strategy reads no ETF says nothing about ETFs at all.
    await page.goto(`/backtests/${control.run.id}`);
    await expect(page.getByTestId("backtest-status")).toHaveText("Completed", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("backtest-etf-conditions")).toHaveCount(0);
  });

  test("tells a Monitor's watcher which ETF sources are ready, and which never will be until bootstrapped", async ({
    page,
  }) => {
    await page.goto("/monitors");
    const stamp = Date.now();
    const list = await post<{ id: string }>(page, "/lists", {
      name: `E2E etf monitor list ${stamp}`,
    });
    created.lists.push(list.id);
    const strategyId = await createStrategy(
      page,
      `E2E etf monitor strategy ${stamp}`,
      [
        STOCK_PRICE_BELOW_EMA,
        { ...etfPriceAbove("ETF_XLK", "SMA_200D"), id: "c-xlk" },
        { ...SPY_RSI_ABOVE_1, id: "c-spy" },
      ],
    );
    created.strategies.push(strategyId);
    // Disabled: this is about what the detail reports, and must not occupy an active-Monitor slot.
    const monitor = await post<{ id: string }>(page, "/monitors", {
      name: `E2E etf watch ${stamp}`,
      strategyId,
      stockListId: list.id,
      enabled: false,
    });
    created.monitors.push(monitor.id);

    const detail = await get<MonitorDetailResponse>(
      page,
      `/monitors/${monitor.id}`,
    );
    // Catalog order, derived at read time from each series' durable state: no scan has run.
    expect(detail.etfSources?.map(({ code, status }) => [code, status])).toEqual(
      [
        ["SP500", "NOT_BOOTSTRAPPED"],
        ["ETF_XLK", "READY"],
      ],
    );
    const latest = detail.etfSources?.[1]?.latestSession as string;
    expect(latest < today()).toBe(true);

    await page.goto(`/monitors/${monitor.id}`);
    const note = page.getByTestId("monitor-etf-sources");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText(
      "ETF conditions are decided at the end of each trading day, on the fund's own completed session",
    );
    const sources = note.getByTestId("monitor-etf-source");
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0)).toHaveAttribute("data-ticker", "SPY");
    await expect(sources.nth(0)).toHaveAttribute("data-ready", "false");
    await expect(sources.nth(0)).toContainText(
      "SPY: its market history has not been loaded yet, so its rules cannot be evaluated",
    );
    await expect(sources.nth(1)).toHaveAttribute("data-ticker", "XLK");
    await expect(sources.nth(1)).toHaveAttribute("data-ready", "true");
    await expect(sources.nth(1)).toContainText(
      "XLK: latest completed session",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(note).toBeVisible();
    await expectNoHorizontalScroll(page);

    // A Monitor whose Strategy reads no ETF carries no such note.
    const stockOnly = await createStrategy(
      page,
      `E2E etf monitor control ${stamp}`,
      [STOCK_PRICE_BELOW_EMA],
    );
    created.strategies.push(stockOnly);
    const control = await post<{ id: string }>(page, "/monitors", {
      name: `E2E etf watch control ${stamp}`,
      strategyId: stockOnly,
      stockListId: list.id,
      enabled: false,
    });
    created.monitors.push(control.id);
    expect(
      (await get<MonitorDetailResponse>(page, `/monitors/${control.id}`))
        .etfSources,
    ).toBeUndefined();
    await page.goto(`/monitors/${control.id}`);
    await expect(page.getByTestId("monitor-detail")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("monitor-etf-sources")).toHaveCount(0);
  });
});
