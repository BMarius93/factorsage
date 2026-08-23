import { describe, expect, it, vi } from "vitest";
import {
  FmpClient,
  FmpRateLimitError,
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
  };
}

describe("FMP retry policy", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter("Mon, 24 Aug 2026 12:00:03 GMT", now)).toBe(3_000);
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
  });

  it("publishes a bounded shared cooldown and retries 429", async () => {
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

  it("does not retry authentication failures or expose the API key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([], 401));
    const client = new FmpClient(config, fetchMock, {
      sleep: async () => {},
    });

    const error = await client
      .getProfile("AAPL")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FmpUnauthorizedError);
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
