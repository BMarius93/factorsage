import { describe, expect, it, vi } from "vitest";
import {
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
