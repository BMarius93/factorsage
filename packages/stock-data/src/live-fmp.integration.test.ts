/**
 * Live FMP verification of the daily technical calculator against the provider's own oracle.
 *
 * This suite NEVER runs by default and is excluded from normal CI. `RUN_LIVE_FMP_TESTS=1` is the
 * only thing that authorizes it — an `FMP_API_KEY` present in a developer's `.env` does not, which
 * is what previously let a direct `vitest` invocation (bypassing the package script's
 * `--exclude`) fire real requests. Run it deliberately with:
 *
 *   RUN_LIVE_FMP_TESTS=1 pnpm --filter @intrinsic/stock-data test:live
 */
import { getFmpConfig, loadRootEnv } from "@intrinsic/config";
import { FMP_EOD_MAX_ROWS_PER_RESPONSE, FmpClient } from "@intrinsic/fmp";
import {
  assertLiveFmpCredentials,
  liveFmpTestsEnabled,
} from "@intrinsic/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { calculateDailyTechnicals } from "./technicals.js";

loadRootEnv();
const describeLive = liveFmpTestsEnabled() ? describe : describe.skip;

async function getFmpTechnical(
  type: "sma" | "ema",
): Promise<Array<{ date: string; value: number }>> {
  const config = getFmpConfig();
  const url = new URL(
    `technical-indicators/${type}`,
    "https://financialmodelingprep.com/stable/",
  );
  url.searchParams.set("symbol", "AAPL");
  url.searchParams.set("periodLength", "20");
  url.searchParams.set("timeframe", "1day");
  url.searchParams.set("from", "2020-01-01");
  url.searchParams.set("to", "2020-09-01");
  url.searchParams.set("apikey", config.apiKey);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: { accept: "application/json" },
  });
  expect(response.ok).toBe(true);
  const payload: unknown = await response.json();
  expect(Array.isArray(payload)).toBe(true);
  return (payload as Array<Record<string, unknown>>).map((row) => {
    const date = row.date;
    const value = row[type];
    if (typeof date !== "string" || typeof value !== "number") {
      throw new Error(`Invalid live FMP ${type.toUpperCase()} response`);
    }
    return { date: date.slice(0, 10), value };
  });
}

describeLive("live FMP verification", () => {
  const client = new FmpClient(() => getFmpConfig());

  // Inside beforeAll, not at module scope: the suite must skip cleanly when the gate is off,
  // whatever the local environment carries. With the gate on, missing or placeholder credentials
  // fail loudly instead of sending a request that cannot succeed.
  beforeAll(() => {
    assertLiveFmpCredentials();
  });

  it("maps the AAPL company profile", async () => {
    const profile = await client.getProfile("AAPL");
    expect(profile?.security).toMatchObject({
      symbol: "AAPL",
      currency: "USD",
      type: "STOCK",
    });
    expect(profile?.security.name).toContain("Apple");
  });

  /**
   * The one price-basis assumption the backtest engine depends on.
   *
   * `historical-price-eod/full` returns a **split-adjusted** series, which is why the canonical
   * variant is named `split-adjusted-eod-full`. The engine models no corporate actions at all, so
   * if the provider ever returned raw traded prices instead, Apple's four-for-one split would
   * arrive as a 75% single-day collapse: every drawdown, every "price below" signal and every
   * Gain/Loss trigger around it would fire on an event that never economically happened.
   *
   * Dividends are a different matter and are deliberately *not* adjusted for — see the price-return
   * statement in `ai/product/backtests.md`. This asserts only that a split is invisible.
   */
  it("loads ascending split-adjusted AAPL EOD data across the 2020 split", async () => {
    const prices = await client.getDailyPrices("AAPL", "live-aapl", {
      from: "2020-01-01",
      to: "2020-09-01",
    });
    expect(prices.length).toBeGreaterThan(100);
    expect((prices[0]?.date ?? "") < (prices.at(-1)?.date ?? "")).toBe(true);
    const preSplit = prices.find((price) => price.date === "2020-08-28");
    expect(preSplit?.close).toBeCloseTo(124.81, 0);
    expect(preSplit?.close).toBeLessThan(200);

    // The four-for-one split took effect on 2020-08-31. On an unadjusted series the close would
    // fall by roughly 75% overnight; on this one it rises.
    const postSplit = prices.find((price) => price.date === "2020-08-31");
    expect(postSplit?.close).toBeGreaterThan((preSplit?.close ?? 0) * 0.9);

    // And nowhere in the window does a single session move by more than a third, which no split
    // ratio the provider might leave unadjusted could satisfy.
    for (let index = 1; index < prices.length; index += 1) {
      const previous = prices[index - 1]?.close ?? 0;
      const current = prices[index]?.close ?? 0;
      expect(previous).toBeGreaterThan(0);
      expect(Math.abs(current / previous - 1)).toBeLessThan(0.34);
    }
  });

  it("paginates a thirty-year AAPL read past the provider's page cap", async () => {
    // The endpoint silently caps one response at `FMP_EOD_MAX_ROWS_PER_RESPONSE` rows and drops
    // the oldest. Apple has traded since 1980, so a thirty-year window holds well over that many
    // trading days: reaching the requested start proves the adapter walked past the cap, and the
    // row count proves the cap is still what the adapter assumes. A provider that lowers the cap
    // makes the first assertion fail here instead of silently shortening every long history.
    const from = "1996-09-04";
    const to = new Date().toISOString().slice(0, 10);
    const prices = await client.getDailyPrices("AAPL", "live-aapl", {
      from,
      to,
    });

    expect(prices.length).toBeGreaterThan(FMP_EOD_MAX_ROWS_PER_RESPONSE);
    // The first trading day at or after the requested start, within a week of it.
    expect(prices[0]?.date ?? "").not.toBe("");
    expect(prices[0]!.date >= from).toBe(true);
    expect(Date.parse(prices[0]!.date) - Date.parse(from)).toBeLessThanOrEqual(
      7 * 86_400_000,
    );
    expect(new Set(prices.map((price) => price.date)).size).toBe(prices.length);
    for (let index = 1; index < prices.length; index += 1) {
      expect(prices[index - 1]!.date < prices[index]!.date).toBe(true);
    }
  });

  it("matches FMP SMA20 and EMA20 oracle values within 0.10", async () => {
    const prices = await client.getDailyPrices("AAPL", "live-aapl", {
      from: "2020-01-01",
      to: "2020-09-01",
    });
    const calculated = calculateDailyTechnicals(prices);
    const [sma, ema] = await Promise.all([
      getFmpTechnical("sma"),
      getFmpTechnical("ema"),
    ]);
    const date = "2020-08-28";
    const local = calculated.find((row) => row.date === date);
    const fmpSma = sma.find((row) => row.date === date);
    const fmpEma = ema.find((row) => row.date === date);
    expect(local?.sma20d).toBeCloseTo(fmpSma?.value ?? Number.NaN, 1);
    expect(local?.ema20d).toBeCloseTo(fmpEma?.value ?? Number.NaN, 1);
  });

  /**
   * The exchange holiday schedule is the one provider contract the Monitor's session boundary
   * depends on, and mapping it defensively is not the same as knowing the shape. This is the only
   * place that can verify it, and it asserts invariants rather than a fixed list: the schedule for
   * a past year must parse, be dated, and contain at least one full closure — a year in which the
   * US market never closed would itself be the anomaly.
   */
  it("returns a parseable NASDAQ holiday schedule with real closures", async () => {
    // The same range `CachedTradingCalendar` asks for: `from` is exclusive, so a year is requested
    // from the last day of the previous one.
    const holidays = await client.getExchangeHolidays(
      "NASDAQ",
      "2023-12-31",
      "2024-12-31",
    );

    for (const holiday of holidays) {
      expect(holiday.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof holiday.fullClose).toBe("boolean");
    }

    const fullCloses = holidays
      .filter((holiday) => holiday.fullClose && holiday.date.startsWith("2024"))
      .map((holiday) => holiday.date);

    // New Year's Day is the boundary case and the reason the range starts a day early: requesting
    // from 2024-01-01 silently drops it, because the provider filters strictly greater-than. It is
    // also the one full closure that occurs every single year, so its absence here would mean the
    // Monitor treats it as a trading session.
    expect(fullCloses).toContain("2024-01-01");
    // A real year has nine or ten; the floor is what makes a degenerate schedule detectable.
    expect(fullCloses.length).toBeGreaterThanOrEqual(6);
  });
});
