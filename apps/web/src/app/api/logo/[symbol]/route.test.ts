import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, MAX_LOGO_BYTES } from "./route";

const IMAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'";

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
    // An SVG opened directly at /api/logo/X is a document on the session-holding origin; the
    // sandboxed, script-free policy is what keeps it inert.
    expect(response.headers.get("Content-Security-Policy")).toBe(IMAGE_CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves every logo with a script-free, unframable, no-sniff policy", async () => {
    stubUpstream(() => pngResponse([1, 2, 3]));

    const response = await call("AAPL");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(IMAGE_CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("asks only the fixed provider host and never follows a redirect", async () => {
    const fetchStub = stubUpstream(() => pngResponse([1]));

    await call("BRK.B");

    expect(String(fetchStub.mock.calls[0]?.[0])).toBe(
      "https://images.financialmodelingprep.com/symbol/BRK.B.png",
    );
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe("error");
  });

  it("treats a redirect as a provider failure, uncached", async () => {
    // What `redirect: "error"` does in a real fetch: the request rejects.
    stubUpstream(() => {
      throw new TypeError("fetch failed: unexpected redirect");
    });
    const rejected = await call("AAPL");
    expect(rejected.status).toBe(502);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");

    // And if a 3xx is ever surfaced as a response instead, it is still not a logo or a miss.
    stubUpstream(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.test/x.svg" },
        }),
    );
    const surfaced = await call("AAPL");
    expect(surfaced.status).toBe(502);
    expect(surfaced.headers.get("Cache-Control")).toBe("no-store");
  });

  it("treats a provider error status as a failure rather than caching it as a miss", async () => {
    for (const status of [429, 500, 503, 403]) {
      stubUpstream(() => new Response("upstream error", { status }));

      const response = await call("AAPL");

      expect(response.status, String(status)).toBe(502);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("treats a gone symbol like an unknown one", async () => {
    stubUpstream(() => new Response("gone", { status: 410 }));

    const response = await call("ZZZZ");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("refuses an oversized body from its declared length without reading it", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    stubUpstream(
      () =>
        new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(MAX_LOGO_BYTES + 1),
          },
        }),
    );

    const response = await call("AAPL");

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Only the stream's own initial pull may have run; nothing was consumed.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("stops reading an undeclared body at the cap instead of buffering it whole", async () => {
    const chunk = 64 * 1024;
    let delivered = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    stubUpstream(
      () =>
        new Response(endless, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );

    const response = await call("AAPL");

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // An endless body is abandoned just past the cap (plus the stream's read-ahead).
    expect(delivered).toBeLessThanOrEqual(MAX_LOGO_BYTES + 3 * chunk);
  });

  it("serves a body exactly at the cap", async () => {
    stubUpstream(() => pngResponse(new Array(MAX_LOGO_BYTES).fill(7)));

    const response = await call("AAPL");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(MAX_LOGO_BYTES));
  });

  it("treats a body that fails mid-stream as a provider failure", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("socket hang up"));
      },
    });
    stubUpstream(
      () =>
        new Response(broken, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    );

    const response = await call("AAPL");

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
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

    // What the timeout signal produces when it fires: an uncached failure, not a miss.
    stubUpstream(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const timedOut = await call("AAPL");
    expect(timedOut.status).toBe(502);
    expect(timedOut.headers.get("Cache-Control")).toBe("no-store");
  });
});
