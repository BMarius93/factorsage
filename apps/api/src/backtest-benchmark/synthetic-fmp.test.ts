import type { AddressInfo } from "node:net";
import { getFmpConfig } from "@intrinsic/config";
import { FmpClient } from "@intrinsic/fmp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerSyntheticFmpRequest,
  createSyntheticFmpServer,
  SYNTHETIC_FMP_API_KEY,
  syntheticBars,
  syntheticDailyBarResponse,
  syntheticLastSession,
  syntheticSessions,
  syntheticStatementResponse,
  syntheticSymbol,
  type SyntheticFmpServer,
} from "./synthetic-fmp";

/**
 * The scale benchmark's synthetic provider: deterministic, shaped exactly like the provider's
 * payloads (proved by mapping them through the production `FmpClient`), and paged like it.
 */

const LAST = "2026-10-16";

describe("synthetic provider data", () => {
  it("is deterministic per symbol and differs between symbols", () => {
    const first = syntheticDailyBarResponse("SYN0001", "2020-01-01", "2020-12-31", LAST);
    const again = syntheticDailyBarResponse("SYN0001", "2020-01-01", "2020-12-31", LAST);
    const other = syntheticDailyBarResponse("SYN0002", "2020-01-01", "2020-12-31", LAST);
    expect(first).toEqual(again);
    expect(first.map((bar) => bar.close)).not.toEqual(other.map((bar) => bar.close));
  });

  it("answers newest first, inside the range, and caps a response at 5000 rows like FMP", () => {
    const year = syntheticDailyBarResponse("SYN0003", "2024-01-01", "2024-12-31", LAST);
    expect(year[0]?.date).toBe("2024-12-31");
    expect(year.at(-1)?.date).toBe("2024-01-02");
    expect(year).toHaveLength(252);

    const all = syntheticDailyBarResponse("SYN0003", "1985-01-01", LAST, LAST);
    expect(all).toHaveLength(5000);
    expect(all[0]?.date).toBe(LAST);
  });

  it("never publishes a bar after the last session", () => {
    const bars = syntheticDailyBarResponse("SYN0004", "2026-10-01", "2026-12-31", LAST);
    expect(bars[0]?.date).toBe(LAST);
  });

  it("keeps every bar's high and low around its open and close", () => {
    for (const bar of syntheticBars("SYN0005", LAST)) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeGreaterThan(0);
    }
  });

  it("trades on the rule-based NYSE calendar", () => {
    const sessions = syntheticSessions("2025-12-31").filter((date) => date.startsWith("2025"));
    // 251 by the standing rules; the real 2025 had 250 (the ad-hoc 2025-01-09 closure), which a
    // rule-based calendar deliberately does not know.
    expect(sessions).toHaveLength(251);
    expect(sessions).not.toContain("2025-12-25");
    expect(sessions).not.toContain("2025-07-04");
  });

  it("publishes statements only once filed, newest first, within the limit", () => {
    const quarterly = syntheticStatementResponse("SYN0006", "income", "quarter", 8, "2026-10-16");
    expect(quarterly).toHaveLength(8);
    expect(quarterly[0]).toMatchObject({ date: "2026-06-30", period: "Q2" });
    const annual = syntheticStatementResponse("SYN0006", "balance", "annual", 40, "2026-10-16");
    expect(annual[0]).toMatchObject({ date: "2025-12-31", period: "FY", fiscalYear: "2025" });
    for (const row of annual) {
      expect(row.totalAssets).toBe(row.totalLiabilitiesAndTotalEquity);
    }
  });

  it("refuses a request without the synthetic key", () => {
    const url = new URL("http://127.0.0.1/stable/profile?symbol=SYN0001&apikey=other");
    expect(answerSyntheticFmpRequest(url, { apiKey: SYNTHETIC_FMP_API_KEY, lastSession: LAST }).status).toBe(401);
  });

  it("names symbols SYN0001…SYN9999", () => {
    expect(syntheticSymbol(1)).toBe("SYN0001");
    expect(syntheticSymbol(1234)).toBe("SYN1234");
    expect(() => syntheticSymbol(0)).toThrow();
  });

  it("dates its last session strictly before today in New York", () => {
    expect(syntheticLastSession(new Date("2026-10-19T15:00:00Z"))).toBe("2026-10-16");
    expect(syntheticLastSession(new Date("2026-10-20T15:00:00Z"))).toBe("2026-10-19");
  });
});

describe("the production FmpClient against the synthetic provider", () => {
  let synthetic: SyntheticFmpServer;
  let client: FmpClient;

  beforeAll(async () => {
    synthetic = createSyntheticFmpServer({ lastSession: LAST, universe: 20 });
    await new Promise<void>((resolve) => synthetic.server.listen(0, "127.0.0.1", resolve));
    const port = (synthetic.server.address() as AddressInfo).port;
    const config = getFmpConfig({
      NODE_ENV: "test",
      FMP_API_KEY: SYNTHETIC_FMP_API_KEY,
      FMP_BASE_URL: `http://127.0.0.1:${port}/stable/`,
    });
    client = new FmpClient(() => ({ ...config, maxRetries: 0 }), fetch);
  });

  afterAll(async () => {
    await synthetic.close();
  });

  it("maps a profile", async () => {
    const profile = await client.getProfile("SYN0007");
    expect(profile?.security).toMatchObject({ symbol: "SYN0007", currency: "USD", type: "STOCK" });
  });

  it("walks thirty-plus years of daily bars across the provider's page cap", async () => {
    const before = synthetic.counters.requests;
    const prices = await client.getDailyPrices("SYN0008", "security-id", {
      from: "1992-10-16",
      to: LAST,
    });
    expect(synthetic.counters.requests - before).toBe(2);
    expect(prices.length).toBeGreaterThan(8_500);
    expect(new Set(prices.map((price) => price.date)).size).toBe(prices.length);
  });

  it("maps every statement type at both cadences, without dropping a filing", async () => {
    for (const type of ["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const) {
      for (const cadence of ["QUARTERLY", "ANNUAL"] as const) {
        const statements = await client.getFinancialStatements(
          "SYN0009",
          "security-id",
          type,
          cadence,
          cadence === "QUARTERLY" ? 148 : 37,
        );
        expect(statements).toHaveLength(cadence === "QUARTERLY" ? 148 : 37);
        expect(statements.every((row) => row.filingDate > row.fiscalDate)).toBe(true);
      }
    }
  });

  it("answers splits and holidays", async () => {
    await expect(client.getStockSplits("SYN0010", "security-id")).resolves.toEqual([]);
    const holidays = await client.getExchangeHolidays("NYSE", "2025-12-31", "2026-12-31");
    expect(holidays.filter((holiday) => holiday.fullClose)).toHaveLength(10);
  });

  it("injects failures when asked", async () => {
    const failing = createSyntheticFmpServer({ lastSession: LAST, failEvery: 1 });
    await new Promise<void>((resolve) => failing.server.listen(0, "127.0.0.1", resolve));
    const port = (failing.server.address() as AddressInfo).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/stable/profile?symbol=SYN0001&apikey=${SYNTHETIC_FMP_API_KEY}`,
    );
    expect(response.status).toBe(429);
    expect(failing.counters.failuresInjected).toBe(1);
    await failing.close();
  });

  it("refuses everything during an outage window, then recovers", async () => {
    const provider = createSyntheticFmpServer({ lastSession: LAST, universe: 20 });
    await new Promise<void>((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}`;
    const profile = `${base}/stable/profile?symbol=SYN0001&apikey=${SYNTHETIC_FMP_API_KEY}`;
    await fetch(`${base}/__synthetic/outage?ms=200&status=429`);
    expect((await fetch(profile)).status).toBe(429);
    expect((await fetch(profile)).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await fetch(profile)).status).toBe(200);
    expect(provider.counters.outageRefusals).toBe(2);
    await provider.close();
  });
});
