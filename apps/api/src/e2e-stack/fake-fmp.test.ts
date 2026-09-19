import type { AddressInfo } from "node:net";
import { getFmpConfig } from "@intrinsic/config";
import { FmpClient, FmpProviderError } from "@intrinsic/fmp";
import { E2E_FAKE_FMP_API_KEY, e2eStackEnvironment } from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerFakeFmpRequest,
  createFakeFmpServer,
  fixtureHolidays,
  nyseFullClosures,
  type FakeFmpFixture,
  type FakeFmpServer,
} from "./fake-fmp";
import {
  e2eFixtureBenchmarkProviderSymbols,
  e2eFixtureSecuritySymbols,
} from "./fixture-boundary";

/**
 * The fixture FMP provider (E2E-001): what it answers, what it refuses, and that the real
 * `FmpClient`, configured exactly as the E2E stack configures it, talks to it and to nothing else.
 */

const FIXTURE: FakeFmpFixture = {
  apiKey: E2E_FAKE_FMP_API_KEY,
  securitySymbols: new Set(e2eFixtureSecuritySymbols()),
  benchmarkSymbols: new Set(e2eFixtureBenchmarkProviderSymbols()),
};

function request(path: string, query: Record<string, string>): URL {
  const url = new URL(path, "http://127.0.0.1:3011/stable/");
  for (const [key, value] of Object.entries({
    apikey: E2E_FAKE_FMP_API_KEY,
    ...query,
  })) {
    url.searchParams.set(key, value);
  }
  return url;
}

describe("fixture FMP answers", () => {
  it("answers daily bars for fixture securities and fixture benchmarks with no rows", () => {
    for (const symbol of [
      "QATEST1",
      "ENTF042",
      "SPY",
      "^GSPC",
      "^DJI",
      "^VIX",
    ]) {
      const answer = answerFakeFmpRequest(
        request("historical-price-eod/full", {
          symbol,
          from: "1996-01-01",
          to: "2026-09-18",
        }),
        FIXTURE,
      );
      expect(answer, symbol).toMatchObject({
        status: 200,
        body: [],
        outcome: "fixture",
      });
    }
  });

  it("answers profiles, statements and current quotes for fixture securities with nothing", () => {
    for (const path of [
      "profile",
      "income-statement",
      "balance-sheet-statement",
      "cash-flow-statement",
    ]) {
      expect(
        answerFakeFmpRequest(request(path, { symbol: "ENTF001" }), FIXTURE),
      ).toMatchObject({ status: 200, body: [], outcome: "fixture" });
    }
    expect(
      answerFakeFmpRequest(
        request("batch-quote", { symbols: "ENTF001,QATEST1" }),
        FIXTURE,
      ),
    ).toMatchObject({ status: 200, body: [], outcome: "fixture" });
  });

  it("refuses loudly, naming the missing fixture, for anything outside the fixtures", () => {
    const cases: [URL, RegExp][] = [
      [
        request("historical-price-eod/full", { symbol: "AAPL" }),
        /no E2E fixture for GET historical-price-eod\/full\?symbol=AAPL/,
      ],
      [request("profile", { symbol: "MSFT" }), /profile\?symbol=MSFT/],
      // A benchmark symbol is never a security: no profile exists for it here.
      [request("profile", { symbol: "SPY" }), /profile\?symbol=SPY/],
      [
        request("batch-quote", { symbols: "QATEST1,AAPL" }),
        /current quotes of AAPL/,
      ],
      [
        request("company-screener", { exchange: "NASDAQ" }),
        /company-screener\?exchange=NASDAQ/,
      ],
      [
        request("dividends", { symbol: "QATEST1" }),
        /dividends\?symbol=QATEST1/,
      ],
    ];
    for (const [url, detail] of cases) {
      const answer = answerFakeFmpRequest(url, FIXTURE);
      expect(answer.status, url.pathname).toBe(404);
      expect(answer.outcome).toBe("unexpected");
      expect(answer.detail).toMatch(detail);
      expect(JSON.stringify(answer.body)).toMatch(detail);
    }
  });

  it("refuses a request without the E2E key and never echoes the key it got", () => {
    const url = request("profile", { symbol: "QATEST1" });
    url.searchParams.set("apikey", "a-real-looking-key-1234567890");
    const answer = answerFakeFmpRequest(url, FIXTURE);

    expect(answer).toMatchObject({ status: 401, outcome: "unexpected" });
    expect(JSON.stringify(answer)).not.toContain("a-real-looking-key");
  });
});

describe("fixture exchange calendar", () => {
  it("produces the NYSE standing full closures, with weekend observance", () => {
    expect(nyseFullClosures(2026)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(nyseFullClosures(2027)).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24",
    ]);
    // A Saturday New Year's Day is not observed; Juneteenth only exists from 2022.
    expect(nyseFullClosures(2022)[0]).toBe("2022-01-17");
    expect(nyseFullClosures(2021)).not.toContain("2021-06-18");
  });

  it("treats `from` as exclusive and `to` as inclusive, like the real endpoint", () => {
    expect(fixtureHolidays("2025-12-31", "2026-12-31")[0]).toBe("2026-01-01");
    expect(fixtureHolidays("2026-01-01", "2026-02-16")).toEqual([
      "2026-01-19",
      "2026-02-16",
    ]);
  });
});

describe("the E2E-configured FmpClient against the fixture server", () => {
  let fake: FakeFmpServer;
  let client: FmpClient;

  beforeAll(async () => {
    fake = createFakeFmpServer(FIXTURE);
    await new Promise<void>((resolve) =>
      fake.server.listen(0, "127.0.0.1", resolve),
    );
    const port = (fake.server.address() as AddressInfo).port;
    // Exactly the environment `pnpm dev:api:e2e` lays over a developer `.env` that holds a real
    // key: the key and the endpoint are both replaced.
    const env = {
      FMP_API_KEY: "developer-real-key-must-not-be-used",
      ...e2eStackEnvironment({
        role: "api",
        repositoryRoot: "/repo",
        testDatabaseUrl: "postgresql://localhost/intrinsic_value_test",
        fakeFmpPort: port,
      }),
    };
    const config = getFmpConfig(env);
    expect(config.baseUrl).toBe(`http://127.0.0.1:${port}/stable/`);
    expect(config.apiKey).toBe(E2E_FAKE_FMP_API_KEY);
    client = new FmpClient(() => ({ ...config, maxRetries: 0 }), fetch);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("serves fixture requests through the production client", async () => {
    await expect(
      client.getDailyPrices("QATEST1", "security-id", {
        from: "2026-09-12",
        to: "2026-09-18",
      }),
    ).resolves.toEqual([]);
    await expect(client.getCurrentQuotes(["ENTF001"])).resolves.toEqual([]);
    const holidays = await client.getExchangeHolidays(
      "NASDAQ",
      "2025-12-31",
      "2026-12-31",
    );
    expect(holidays.filter((holiday) => holiday.fullClose)).toHaveLength(10);
  });

  it("fails an unexpected request at once, non-retryably, and journals it", async () => {
    const before = fake.journal.length;
    const failure = await client
      .getProfile("AAPL")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FmpProviderError);
    expect((failure as FmpProviderError).statusCode).toBe(404);
    expect((failure as FmpProviderError).retryable).toBe(false);
    const entries = fake.journal.slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      endpoint: "profile",
      query: { symbol: "AAPL" },
      outcome: "unexpected",
    });
    // The journal never holds the key.
    expect(JSON.stringify(fake.journal)).not.toContain(E2E_FAKE_FMP_API_KEY);
  });

  it("exposes the journal and its health on control paths FMP never uses", async () => {
    const port = (fake.server.address() as AddressInfo).port;
    const health = (await (
      await fetch(`http://127.0.0.1:${port}/__e2e/health`)
    ).json()) as { status: string; securities: number };
    expect(health).toMatchObject({ status: "ok", securities: 102 });

    const journal = (await (
      await fetch(`http://127.0.0.1:${port}/__e2e/journal?after=0`)
    ).json()) as { entries: unknown[]; last: number };
    expect(journal.entries).toHaveLength(fake.journal.length);
    expect(journal.last).toBe(fake.journal.length);
  });
});
