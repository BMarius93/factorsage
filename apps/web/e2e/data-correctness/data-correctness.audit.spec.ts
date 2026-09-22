import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "../fixtures";
import { qaPersona } from "../utils/env";
import { signInThroughUi } from "../utils/sign-in";

/**
 * What the user actually sees, against the independently derived values of the data-correctness
 * audit. Run only by `pnpm audit:data-correctness` (see `playwright.data-correctness.config.ts`).
 *
 * The expected display strings are formatted here with the platform's own `Intl.NumberFormat`
 * under the product's documented presentation (en-US, two decimals, signed returns, drawdown shown
 * as a loss), never with the web app's helpers — calculation and formatting are checked apart:
 * the audit proved the number, and this proves the page shows that number.
 */

const artifacts = process.env.AUDIT_ARTIFACTS ?? "";
type Check = {
  area: string;
  id: string;
  expected: string;
  actual: string | null;
  pass: boolean;
};
const checks: Check[] = [];

function record(
  area: string,
  id: string,
  expected: string,
  actual: string | null,
): void {
  const pass = actual !== null && actual.trim() === expected;
  checks.push({ area, id, expected, actual: actual?.trim() ?? null, pass });
  expect.soft(actual?.trim() ?? null, `${area}: ${id}`).toBe(expected);
}

function contains(
  area: string,
  id: string,
  haystack: string | null,
  needle: string,
): void {
  const pass = haystack !== null && haystack.includes(needle);
  checks.push({
    area,
    id,
    expected: needle,
    actual: pass ? needle : ((haystack ?? null)?.slice(0, 300) ?? null),
    pass,
  });
  expect.soft(pass, `${area}: ${id} — expected to find ${needle}`).toBe(true);
}

const money = (value: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
const signedMoney = (value: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    signDisplay: "exceptZero",
  }).format(value);
const percentPoints = (value: number): string =>
  `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
const signedPercentPoints = (value: number): string =>
  `${new Intl.NumberFormat("en-US", { signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
const signedFraction = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const count = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const shares = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
const compact = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const day = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
const PLACEHOLDER = "—";

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(artifacts, "ui", name), "utf8")) as T;
}

type BacktestExpectation = {
  caseId: string;
  runId: string;
  summary: Record<string, number | null>;
  annualReturns: { year: string; returnPercent: number; partial: boolean }[];
  tradeCount: number;
  newestTrades: {
    date: string;
    symbol: string;
    action: string;
    source: string;
    levelPercentage: number | null;
    shares: number;
    price: number;
    amount: number;
    realizedPnl: number | null;
    realizedPnlPercent: number | null;
  }[];
  configuration: {
    period: { startDate: string; endDate: string };
    initialCapital: number;
    monthlyContribution: number;
    maximumPositions: number;
    securities: number;
    equityRows: number;
    firstDate: string;
    lastDate: string;
  };
};

async function text(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  return (await locator.count()) > 0 ? await locator.innerText() : null;
}

test.afterAll(() => {
  mkdirSync(join(artifacts, "ui"), { recursive: true });
  writeFileSync(
    join(artifacts, "ui", "observed.json"),
    `${JSON.stringify({ checks }, null, 2)}\n`,
  );
});

test("backtest results, stock details and dashboard show the audited values", async ({
  page,
}) => {
  expect(
    artifacts,
    "AUDIT_ARTIFACTS must point at artifacts/data-correctness-audit",
  ).not.toBe("");
  await signInThroughUi(page, qaPersona("ADMIN_USER"));

  // ---- Backtest Results -----------------------------------------------------------------------
  const { runs } = read<{ runs: BacktestExpectation[] }>(
    "backtest-expectations.json",
  );
  for (const run of runs) {
    const area = `backtest ${run.caseId}`;
    await page.goto(`/backtests/${run.runId}`);
    await expect(
      page.locator('[data-testid="backtest-run"][data-status="COMPLETED"]'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("backtest-metrics")).toBeVisible();
    const tile = async (key: string): Promise<string | null> =>
      text(page, `[data-testid="metric-${key}"] dd`);
    const s = run.summary;
    const signedOrPlaceholder = (value: number | null): string =>
      value === null ? PLACEHOLDER : signedPercentPoints(value);
    record(
      area,
      "Portfolio return",
      signedOrPlaceholder(s.portfolioReturnPercent!),
      await tile("portfolio-return"),
    );
    record(
      area,
      "S&P 500 return",
      signedOrPlaceholder(s.benchmarkReturnPercent ?? null),
      await tile("benchmark-return"),
    );
    record(
      area,
      "Excess return",
      signedOrPlaceholder(s.alphaPercent ?? null),
      await tile("alpha"),
    );
    record(
      area,
      "Portfolio value",
      money(s.finalValue!),
      await tile("portfolio-value"),
    );
    record(
      area,
      "Net profit",
      signedMoney(s.netProfit!),
      await tile("net-profit"),
    );
    record(
      area,
      "Max drawdown",
      s.maxDrawdownPercent! > 0
        ? `-${percentPoints(s.maxDrawdownPercent!)}`
        : percentPoints(s.maxDrawdownPercent!),
      await tile("max-drawdown"),
    );
    record(area, "Trades", count(s.totalTrades!), await tile("trades"));
    record(
      area,
      "CAGR",
      signedOrPlaceholder(s.portfolioCagrPercent ?? null),
      await tile("cagr"),
    );

    // Annual returns: each year alone, partial years marked.
    record(
      area,
      "annual year count",
      String(run.annualReturns.length),
      await page
        .getByTestId("backtest-annual-returns")
        .getAttribute("data-year-count"),
    );
    for (const year of run.annualReturns) {
      const cell = page.locator(
        `[data-testid="backtest-annual-return"][data-year="${year.year}"]`,
      );
      record(
        area,
        `annual ${year.year}`,
        signedPercentPoints(year.returnPercent),
        (await cell.count()) > 0 ? await cell.locator("dd").innerText() : null,
      );
      record(
        area,
        `annual ${year.year} partial`,
        String(year.partial),
        (await cell.getAttribute("data-partial")) === "true" ? "true" : "false",
      );
    }

    // Chart: the served curve spans the simulated period and every simulated day up to 1,500.
    const chart = page.getByTestId("backtest-chart");
    record(
      area,
      "chart series",
      "3",
      await chart.getAttribute("data-series-count"),
    );
    record(
      area,
      "chart points",
      String(Math.min(run.configuration.equityRows, 1500)),
      await chart.getAttribute("data-strategy-points"),
    );
    record(
      area,
      "chart from",
      run.configuration.firstDate,
      await chart.getAttribute("data-curve-from"),
    );
    record(
      area,
      "chart through",
      run.configuration.lastDate,
      await chart.getAttribute("data-curve-through"),
    );

    // Run configuration.
    await page.getByTestId("run-configuration").locator("summary").click();
    const configuration = await text(
      page,
      '[data-testid="backtest-configuration"]',
    );
    contains(
      area,
      "configuration period",
      configuration,
      `${day(run.configuration.period.startDate)} – ${day(run.configuration.period.endDate)}`,
    );
    contains(
      area,
      "configuration initial capital",
      configuration,
      money(run.configuration.initialCapital),
    );
    contains(
      area,
      "configuration monthly contribution",
      configuration,
      run.configuration.monthlyContribution > 0
        ? money(run.configuration.monthlyContribution)
        : "None",
    );
    contains(
      area,
      "configuration stocks",
      configuration,
      count(run.configuration.securities),
    );

    // Trade log: newest first; the first rows are the newest trades of the reference ledger.
    if (run.tradeCount === 0) {
      await expect(page.getByTestId("backtest-trades-empty")).toBeVisible();
      record(area, "trade log empty", "true", "true");
    } else {
      await expect(
        page.getByTestId("backtest-trade-row").first(),
      ).toBeVisible();
      const rows = page.getByTestId("backtest-trade-row");
      for (const [position, trade] of run.newestTrades.entries()) {
        const rowText =
          (await rows.count()) > position
            ? await rows.nth(position).innerText()
            : null;
        const label =
          trade.source === "END_OF_BACKTEST"
            ? "Sell 100%"
            : trade.action === "FINAL_EXIT"
              ? "Final exit"
              : `${trade.action === "BUY" ? "Buy" : "Sell"} ${trade.levelPercentage}%`;
        const id = `trade ${position + 1} ${trade.date} ${trade.symbol}`;
        contains(area, `${id} symbol`, rowText, trade.symbol);
        contains(area, `${id} date`, rowText, day(trade.date));
        contains(area, `${id} action`, rowText, label);
        contains(area, `${id} amount`, rowText, money(trade.amount));
        contains(
          area,
          `${id} shares @ price`,
          rowText,
          `${shares(trade.shares)} @ ${money(trade.price)}`,
        );
        if (trade.source === "END_OF_BACKTEST") {
          contains(area, `${id} reason`, rowText, "End of backtest");
        }
        if (trade.realizedPnl !== null) {
          contains(
            area,
            `${id} realized`,
            rowText,
            `${signedMoney(trade.realizedPnl)} · ${signedPercentPoints(trade.realizedPnlPercent!)}`,
          );
        }
      }
      contains(
        area,
        "trade log total",
        await text(page, '[data-testid="backtest-trades-footer"]'),
        count(run.tradeCount),
      );
    }
  }

  // ---- Stock Details --------------------------------------------------------------------------
  const { symbols } = read<{
    symbols: {
      symbol: string;
      currency: string;
      latest: {
        date: string;
        close: number;
        high: number;
        low: number;
        volume: number;
      } | null;
      previousClose: number | null;
      change: number | null;
      changeFraction: number | null;
      windowLow: number;
      windowHigh: number;
      models: Record<string, { value: number; date: string } | null>;
      blends: Record<string, { value: number; date: string } | null>;
      movingAverages: Record<string, number | null>;
    }[];
  }>("stock-details-expectations.json");
  const MODEL_LABELS: Record<string, string> = {
    DCF_FCFF: "DCF (FCFF)",
    RESIDUAL_INCOME: "Residual Income",
    DDM: "Dividend Discount (DDM)",
    GRAHAM: "Graham",
  };
  const BLEND_LABELS: Record<string, string> = {
    BALANCED: "Balanced",
    CONSERVATIVE: "Conservative",
    DIVIDEND: "Dividend",
  };
  const MA_LABELS: Record<string, string> = {
    sma20d: "SMA 20D",
    sma50d: "SMA 50D",
    sma100d: "SMA 100D",
    sma200d: "SMA 200D",
    ema20d: "EMA 20D",
    ema50d: "EMA 50D",
    ema200d: "EMA 200D",
    sma20w: "SMA 20W",
    sma50w: "SMA 50W",
    sma100w: "SMA 100W",
    sma200w: "SMA 200W",
    ema20w: "EMA 20W",
    ema50w: "EMA 50W",
    ema200w: "EMA 200W",
  };
  for (const stock of symbols) {
    const area = `stock ${stock.symbol}`;
    await page.goto(`/stocks/${stock.symbol}`);
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(stock.symbol) }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('p[class*="price"]').first()).toBeVisible({
      timeout: 60_000,
    });
    if (!stock.latest) {
      continue;
    }
    record(
      area,
      "latest close",
      money(stock.latest.close, stock.currency),
      await text(page, 'p[class*="price"]'),
    );
    const change = await text(page, 'p[class*="change"]');
    if (stock.change !== null && stock.changeFraction !== null) {
      contains(
        area,
        "change",
        change,
        `${signedMoney(stock.change, stock.currency)} (${signedFraction(stock.changeFraction)})`,
      );
    }
    contains(
      area,
      "as-of date",
      await text(page, 'p[class*="asOf"]'),
      day(stock.latest.date),
    );
    const facts = await text(page, "#key-facts");
    contains(
      area,
      "previous close",
      facts,
      money(stock.previousClose!, stock.currency),
    );
    contains(
      area,
      "day range low",
      facts,
      money(stock.latest.low, stock.currency),
    );
    contains(
      area,
      "day range high",
      facts,
      money(stock.latest.high, stock.currency),
    );
    contains(
      area,
      "52-week low",
      facts,
      money(stock.windowLow, stock.currency),
    );
    contains(
      area,
      "52-week high",
      facts,
      money(stock.windowHigh, stock.currency),
    );
    contains(area, "volume", facts, compact(stock.latest.volume));

    for (const [blend, value] of Object.entries(stock.blends)) {
      if (!value) {
        continue;
      }
      const tile = page
        .locator('ul[aria-label="Blended intrinsic values"] li')
        .filter({ hasText: BLEND_LABELS[blend]! })
        .first();
      contains(
        area,
        `blend ${blend}`,
        (await tile.count()) > 0 ? await tile.innerText() : null,
        money(value.value, stock.currency),
      );
    }
    const modelList = await text(
      page,
      'dl[aria-label="Intrinsic values by model"]',
    );
    for (const [model, value] of Object.entries(stock.models)) {
      if (!value) {
        continue;
      }
      contains(area, `model ${model} label`, modelList, MODEL_LABELS[model]!);
      contains(
        area,
        `model ${model} value`,
        modelList,
        money(value.value, stock.currency),
      );
    }
    const technicals = await text(page, "#technicals");
    for (const [column, value] of Object.entries(stock.movingAverages)) {
      if (value === null) {
        continue;
      }
      contains(
        area,
        `${MA_LABELS[column]} label`,
        technicals,
        MA_LABELS[column]!,
      );
      contains(
        area,
        `${MA_LABELS[column]} value`,
        technicals,
        money(value, stock.currency),
      );
    }
  }

  // ---- Dashboard ------------------------------------------------------------------------------
  const dashboard = read<{
    session: string;
    rows: {
      monitor: string;
      symbol: string;
      levelKind: string;
      levelPercentage: number | null;
      state: string;
      price: number | null;
    }[];
  }>("dashboard-expectations.json");
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
  await expect(page.getByTestId("dashboard-signals")).toBeVisible({
    timeout: 60_000,
  });
  const rows = page.getByTestId("dashboard-signal-row");
  const served: { text: string; level: string | null; state: string | null }[] =
    [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    served.push({
      text: await row.innerText(),
      level: await row
        .locator("[data-level]")
        .first()
        .getAttribute("data-level"),
      state: await row
        .locator("[data-state]")
        .first()
        .getAttribute("data-state"),
    });
  }
  const audit = served.filter((row) => row.text.includes("DCA-AUDIT-"));
  record(
    "dashboard",
    "audit monitor rows shown",
    String(dashboard.rows.length),
    String(audit.length),
  );
  const LEVEL_LABELS: Record<string, string> = {
    BUY: "Buy",
    SELL: "Sell",
    FINAL_EXIT: "Final exit",
  };
  for (const expected of dashboard.rows) {
    const label =
      expected.levelPercentage === null
        ? LEVEL_LABELS[expected.levelKind]!
        : `${LEVEL_LABELS[expected.levelKind]} ${expected.levelPercentage}%`;
    const id = `${expected.monitor} ${expected.symbol} ${label}`;
    const match = audit.find(
      (row) =>
        row.text.includes(expected.monitor) &&
        new RegExp(`(^|\\s)${expected.symbol}(\\s|$)`).test(row.text) &&
        row.level === expected.levelKind &&
        row.text.includes(label) &&
        row.state === expected.state,
    );
    record(
      "dashboard",
      `${id} present with state ${expected.state}`,
      "true",
      match ? "true" : "false",
    );
    if (match && expected.price !== null) {
      contains("dashboard", `${id} price`, match.text, money(expected.price));
    }
  }
});
