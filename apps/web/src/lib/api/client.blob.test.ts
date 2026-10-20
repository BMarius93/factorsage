import { RATE_LIMITED_CODE } from "@intrinsic/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGetBlob } from "./client";

/**
 * `apiGetBlob` is `apiGet` for a file: the same credentials and the same error translation, with
 * the body handed back as bytes instead of parsed JSON.
 */
describe("apiGetBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the session cookie, never caches, and resolves with the body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("Sequence,Date\r\n", {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await apiGetBlob("/backtests/run-1/trades/export", {
      query: { symbol: "AAPL" },
    });

    expect(await blob.text()).toBe("Sequence,Date\r\n");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/backtests\/run-1\/trades\/export\?symbol=AAPL$/);
    expect(init).toMatchObject({ credentials: "include", cache: "no-store" });
  });

  it("refuses with the API's own error, wait included", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 429,
              message: "Too many requests. Retry in 120 seconds.",
              code: RATE_LIMITED_CODE,
              policy: "data-export",
              retryAfterSeconds: 120,
            }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const failure = await apiGetBlob("/backtests/run-1/trades/export").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 429,
      code: RATE_LIMITED_CODE,
      retryAfterSeconds: 120,
    });
  });
});
