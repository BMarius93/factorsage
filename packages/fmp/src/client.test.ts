import { describe, expect, it, vi } from "vitest";
import {
  FMP_EOD_MAX_ROWS_PER_RESPONSE,
  FmpClient,
  FmpProviderError,
  FmpRateLimitError,
  FmpTransientError,
  FmpUnauthorizedError,
  parseRetryAfter,
  type FmpRequestGate,
} from "./client.js";

const profile = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD",
};

function response(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function config() {
  return {
    apiKey: "test-secret-key",
    timeoutMs: 1_000,
    maxRetries: 2,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5_000,
    maxRetryWaitMs: 30_000,
  };
}

function statementResponseRow() {
  return {
    symbol: "AAPL",
    date: "2020-03-31",
    reportedCurrency: "USD",
    filingDate: "2020-05-01",
    fiscalYear: 2020,
    period: "Q1",
  };
}

describe("FMP retry policy", () => {
  it.each([
    ["INCOME", "income-statement", "QUARTERLY", "quarter"],
    ["INCOME", "income-statement", "ANNUAL", "annual"],
    ["BALANCE_SHEET", "balance-sheet-statement", "QUARTERLY", "quarter"],
    ["BALANCE_SHEET", "balance-sheet-statement", "ANNUAL", "annual"],
    ["CASH_FLOW", "cash-flow-statement", "QUARTERLY", "quarter"],
    ["CASH_FLOW", "cash-flow-statement", "ANNUAL", "annual"],
  ] as const)(
    "builds %s %s requests without a duplicated stable prefix",
    async (statementType, expectedPath, cadence, expectedPeriod) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([statementResponseRow()]));
      const client = new FmpClient(config, fetchMock);

      await expect(
        client.getFinancialStatements(
          "aapl",
          "security-1",
          statementType,
          cadence,
          123,
        ),
      ).resolves.toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const firstCall = fetchMock.mock.calls[0];
      const requestUrl = new URL(String(firstCall?.[0]));
      expect(requestUrl.pathname).toBe(`/stable/${expectedPath}`);
      expect(requestUrl.pathname).not.toContain("/stable/stable/");
      expect(requestUrl.searchParams.get("symbol")).toBe("AAPL");
      expect(requestUrl.searchParams.get("period")).toBe(expectedPeriod);
      expect(requestUrl.searchParams.get("limit")).toBe("123");
      expect(requestUrl.searchParams.get("apikey")).toBe("test-secret-key");
    },
  );

  it("returns successful and empty payloads without retry", async () => {
    const success = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([profile]));
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response([]));

    await expect(
      new FmpClient(config, success).getProfile("AAPL"),
    ).resolves.toMatchObject({
      providerSymbol: "AAPL",
    });
    await expect(
      new FmpClient(config, empty).getProfile("AAPL"),
    ).resolves.toBeNull();
    expect(success).toHaveBeenCalledTimes(1);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter("Mon, 24 Aug 2026 12:00:03 GMT", now)).toBe(3_000);
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
  });

  it("publishes the full short Retry-After and retries after two seconds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([], 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(response([profile]));
    const delays: number[] = [];
    const cooldowns: number[] = [];
    const gate: FmpRequestGate = {
      run: (request) => request(),
      publishCooldown: async (delayMs) => {
        cooldowns.push(delayMs);
      },
    };
    const client = new FmpClient(config, fetchMock, {
      gate,
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(client.getProfile("AAPL")).resolves.toMatchObject({
      providerSymbol: "AAPL",
    });
    expect(delays).toEqual([2_000]);
    expect(cooldowns).toEqual([2_000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors an HTTP-date Retry-After", async () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([], 429, {
          "retry-after": "Mon, 24 Aug 2026 12:00:02 GMT",
        }),
      )
      .mockResolvedValueOnce(response([profile]));
    const delays: number[] = [];
    const client = new FmpClient(config, fetchMock, {
      now: () => now,
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(client.getProfile("AAPL")).resolves.toBeTruthy();
    expect(delays).toEqual([2_000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("publishes a long Retry-After without sleeping or retrying early", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([], 429, { "retry-after": "120" }));
    const cooldowns: number[] = [];
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();
    const client = new FmpClient(config, fetchMock, {
      gate: {
        run: (request) => request(),
        publishCooldown: async (delayMs) => {
          cooldowns.push(delayMs);
        },
      },
      random: () => 0,
      sleep,
    });

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRateLimitError,
    );
    expect(cooldowns).toEqual([120_000]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("publishes a 429 cooldown before releasing the concurrency permit", async () => {
    let insideGate = false;
    const gate: FmpRequestGate = {
      async run(request) {
        insideGate = true;
        try {
          return await request();
        } finally {
          insideGate = false;
        }
      },
      async publishCooldown() {
        expect(insideGate).toBe(true);
      },
    };
    const client = new FmpClient(
      () => ({ ...config(), maxRetries: 0 }),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([], 429, { "retry-after": "2" })),
      { gate, random: () => 0 },
    );

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRateLimitError,
    );
  });

  it("uses bounded exponential retry for transient and network failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("reset"))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([profile]));
    const delays: number[] = [];
    const client = new FmpClient(config, fetchMock, {
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await client.getProfile("AAPL");
    expect(delays).toEqual([100, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps no-header backoff capped after adding jitter", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([profile]));
    const delays: number[] = [];
    const client = new FmpClient(
      () => ({
        ...config(),
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 110,
      }),
      fetchMock,
      {
        random: () => 0.999,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    await expect(client.getProfile("AAPL")).resolves.toBeTruthy();
    expect(delays).toEqual([110]);
  });

  it("bounds cumulative retry sleep across attempts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([], 429));
    const delays: number[] = [];
    const cooldowns: number[] = [];
    const client = new FmpClient(
      () => ({ ...config(), maxRetries: 3, maxRetryWaitMs: 250 }),
      fetchMock,
      {
        gate: {
          run: (request) => request(),
          publishCooldown: async (delayMs) => {
            cooldowns.push(delayMs);
          },
        },
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRateLimitError,
    );
    expect(delays).toEqual([100]);
    expect(cooldowns).toEqual([100, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([408, 500, 502, 503, 504])(
    "retries transient HTTP %d with bounded backoff",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([], status))
        .mockResolvedValueOnce(response([profile]));
      const delays: number[] = [];
      const client = new FmpClient(config, fetchMock, {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      });

      await expect(client.getProfile("AAPL")).resolves.toBeTruthy();
      expect(delays).toEqual([100]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    new Error("network reset"),
    new DOMException("request timed out", "AbortError"),
  ])("bounds retries for network and timeout rejection", async (failure) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response([profile]));
    const delays: number[] = [];
    const client = new FmpClient(config, fetchMock, {
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(client.getProfile("AAPL")).resolves.toBeTruthy();
    expect(delays).toEqual([100]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403] as const)(
    "does not retry HTTP %d authentication failures or expose the API key",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([], status));
      const client = new FmpClient(config, fetchMock, {
        sleep: async () => {},
      });

      const error = await client
        .getProfile("AAPL")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FmpUnauthorizedError);
      expect(String(error)).not.toContain("test-secret-key");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry other rejected 4xx responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([], 404));
    const client = new FmpClient(config, fetchMock);

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid JSON shape without leaking request secrets", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ unexpected: true }));
    const client = new FmpClient(config, fetchMock);

    const error = await client
      .getProfile("AAPL")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FmpProviderError);
    expect(error).not.toBeInstanceOf(FmpTransientError);
    expect(String(error)).not.toContain("test-secret-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the configured retry bound", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([], 429));
    const cooldowns: number[] = [];
    const client = new FmpClient(config, fetchMock, {
      gate: {
        run: (request) => request(),
        publishCooldown: async (delayMs) => {
          cooldowns.push(delayMs);
        },
      },
      random: () => 0,
      sleep: async () => {},
    });

    await expect(client.getProfile("AAPL")).rejects.toBeInstanceOf(
      FmpRateLimitError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cooldowns).toEqual([100, 200, 400]);
  });
});

/** `count` consecutive weekday rows ending on `last`, newest first, the way FMP returns them. */
function tradingDaysEndingOn(last: string, count: number) {
  const rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
  const cursor = new Date(`${last}T00:00:00.000Z`);
  while (rows.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const date = cursor.toISOString().slice(0, 10);
      rows.push({ date, open: 10, high: 11, low: 9, close: 10.5, volume: 1_000 });
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return rows;
}

function requestedWindow(call: unknown[]): { from: string | null; to: string | null } {
  const url = call[0] as URL;
  return { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
}

describe("FMP daily price pagination", () => {
  it("returns a short page as-is, ascending, with one request", async () => {
    const page = tradingDaysEndingOn("2024-03-08", 5);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(page));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "aapl",
      "security-1",
      { from: "2024-03-01", to: "2024-03-08" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedWindow(fetchMock.mock.calls[0]!)).toEqual({
      from: "2024-03-01",
      to: "2024-03-08",
    });
    expect(rows.map((row) => row.date)).toEqual(
      [...page].map((row) => row.date).reverse(),
    );
  });

  it("walks back past a full page until the provider answers short", async () => {
    // A thirty-year window: the provider caps the first answer at its page limit and drops the
    // oldest years without saying so. The adapter must notice the full page and ask again for
    // everything before the oldest row it received, and stop only on a short page.
    const first = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const oldestOfFirst = first.at(-1)!.date;
    const dayBefore = new Date(`${oldestOfFirst}T00:00:00.000Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const second = tradingDaysEndingOn(dayBefore.toISOString().slice(0, 10), 2_545);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      { from: "1996-08-31", to: "2026-09-04" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedWindow(fetchMock.mock.calls[0]!)).toEqual({
      from: "1996-08-31",
      to: "2026-09-04",
    });
    // The second page starts where the caller's window starts and ends the day before the oldest
    // row already received, so the two pages cannot overlap.
    expect(requestedWindow(fetchMock.mock.calls[1]!)).toEqual({
      from: "1996-08-31",
      to: dayBefore.toISOString().slice(0, 10),
    });
    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE + 2_545);
    expect(rows[0]!.date).toBe(second.at(-1)!.date);
    expect(rows.at(-1)!.date).toBe("2026-09-03");
    expect(new Set(rows.map((row) => row.date)).size).toBe(rows.length);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]!.date < rows[index]!.date).toBe(true);
    }
  });

  it("stops after a full page whose oldest row already reaches the requested start", async () => {
    const page = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const from = page.at(-1)!.date;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(page));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      { from, to: "2026-09-04" },
    );

    // Nothing older can exist inside the window, so a second request would only be an empty one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE);
  });

  it("treats a full page followed by an empty one as complete", async () => {
    const page = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response([]));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      { from: "1996-08-31", to: "2026-09-04" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE);
  });

  it("keeps one row per date when a later page repeats a day", async () => {
    const first = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const oldest = first.at(-1)!;
    // A page that re-describes the oldest day already received, then older history.
    const second = [oldest, ...tradingDaysEndingOn("2000-01-07", 3)];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      { from: "1996-08-31", to: "2026-09-04" },
    );

    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE + 3);
    expect(new Set(rows.map((row) => row.date)).size).toBe(rows.length);
  });

  it("paginates an open-ended window until the provider runs out of history", async () => {
    const first = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const second = tradingDaysEndingOn("2006-10-17", 10);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedWindow(fetchMock.mock.calls[0]!)).toEqual({ from: null, to: null });
    expect(requestedWindow(fetchMock.mock.calls[1]!).from).toBeNull();
    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE + 10);
  });

  it("ends the walk when a full page lies outside the window it was asked for", async () => {
    // A provider answering with rows newer than `to` would otherwise steer the walk forwards
    // forever. The adapter keeps what it received and stops.
    const page = tradingDaysEndingOn("2026-09-03", FMP_EOD_MAX_ROWS_PER_RESPONSE);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(page));

    const rows = await new FmpClient(config, fetchMock).getDailyPrices(
      "AAPL",
      "security-1",
      { from: "1996-08-31", to: "2006-10-11" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(FMP_EOD_MAX_ROWS_PER_RESPONSE);
  });
});
