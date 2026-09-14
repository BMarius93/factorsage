import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/** The route reads only `context.params`, so a bare Request is enough to drive it. */
function request(): Request {
  return new Request("http://localhost/api/logo/AAPL");
}

function call(symbol: string): Promise<Response> {
  return GET(request(), { params: Promise.resolve({ symbol }) });
}

function pngResponse(bytes: readonly number[]): Response {
  return new Response(Uint8Array.from(bytes).buffer as ArrayBuffer, {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

function stubUpstream(
  handler: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn((input: string | URL | Request) =>
    Promise.resolve(handler(String(input))),
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/logo/[symbol]", () => {
  it("normalizes the ticker before asking upstream", async () => {
    const fetchStub = stubUpstream(() => pngResponse([1, 2, 3]));

    const response = await call(" aapl ");

    expect(response.status).toBe(200);
    expect(String(fetchStub.mock.calls[0]?.[0])).toContain("AAPL.png");
  });

  it("caches a served logo for a day and allows a week of stale reuse", async () => {
    stubUpstream(() => pngResponse([1, 2, 3, 4]));

    const response = await call("AAPL");

    // The mechanism behind "logos do not visibly reload while navigating": every surface asks
    // for the same same-origin URL, and the browser answers it from cache for a day.
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("passes through the provider's own image type", async () => {
    stubUpstream(
      () =>
        new Response("<svg />", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    );

    const response = await call("AAPL");

    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("refuses a symbol that could change the upstream request", async () => {
    const fetchStub = stubUpstream(() => pngResponse([1]));

    for (const symbol of ["../../etc/passwd", "AA PL", "A".repeat(21), ""]) {
      const response = await call(symbol);
      expect(response.status).toBe(400);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reports an unknown logo as a miss, and caches the miss", async () => {
    stubUpstream(() => new Response("nope", { status: 404 }));

    const response = await call("ZZZZ");

    expect(response.status).toBe(404);
    // Most of the catalog has no mark upstream. Without this, every logo-less row would re-ask
    // on every render of every screen.
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("treats a non-image 200 as a miss rather than caching an error page as a logo", async () => {
    stubUpstream(
      () =>
        new Response("<html>Not found</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    const response = await call("ZZZZ");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("does not cache an upstream failure", async () => {
    stubUpstream(() => {
      throw new Error("connect ECONNREFUSED");
    });

    const response = await call("AAPL");

    // A provider outage says nothing about the security. Caching it would keep the mark missing
    // long after the provider recovered.
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("gives up on a stalled provider instead of holding the request open", async () => {
    const fetchStub = stubUpstream(() => pngResponse([1]));

    await call("AAPL");

    const init = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
