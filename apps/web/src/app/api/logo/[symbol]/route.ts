import { LOGO_CONTENT_SECURITY_POLICY } from "../../../../lib/security-headers";
import {
  isSafeLogoSymbol,
  normalizeLogoSymbol,
} from "../../../../lib/stock-logo";

/**
 * The product's company-logo endpoint, and the only place in the web application that knows a
 * provider image URL.
 *
 * It exists so the browser loads every mark from FactorSage: one long-lived cache entry per
 * ticker shared by every surface, and same-origin pixels the `StockLogo` brightness check can
 * sample. `lib/stock-logo.ts` explains the whole rule; this file is its server half.
 *
 * Deliberately thin. It resolves nothing, stores nothing and authenticates nobody: a company logo
 * is public, and a ticker is not a secret. The API is not on this path at all — the mark it
 * projects on a security identifies which securities the catalog has profiled, while the bytes
 * come from here for any valid ticker.
 */

/** FMP's canonical symbol image, and the shape every persisted `SecurityProfile.logoUrl` has. */
function providerLogoUrl(symbol: string): string {
  return `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(symbol)}.png`;
}

/**
 * A day fresh, a week servable while it revalidates.
 *
 * Logos change on the order of a rebrand, so the cost of being a day stale is nothing and the
 * benefit is that navigating the product never visibly reloads a mark it has already shown.
 */
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

/**
 * A miss is cached too, for an hour.
 *
 * Most of the catalog has no mark upstream, and every one of those rows would otherwise re-ask on
 * every render of every screen. An hour is short enough that a logo appearing upstream shows up
 * the same session, and long enough that a list of two hundred logo-less symbols costs one round
 * of requests rather than one per navigation.
 */
const MISSING_CACHE_CONTROL = "public, max-age=3600";

/** Long enough for a cold provider CDN, short enough not to hold a connection open on a stall. */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * The most a logo may weigh. Provider marks are a few kilobytes; anything near this is not a logo,
 * and the proxy must not buffer an arbitrarily large body into server memory to find that out.
 */
export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * Provider bytes on the session-holding origin must be inert and unframable; see
 * `LOGO_CONTENT_SECURITY_POLICY`. `next.config` serves the same policy for this path, because a
 * config header rule would otherwise replace the one set here.
 */
const IMAGE_SECURITY_HEADERS = {
  "Content-Security-Policy": LOGO_CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
} as const;

/** Upstream answers that mean "this security has no mark", as opposed to "the provider failed". */
const MISSING_UPSTREAM_STATUSES = new Set([404, 410]);

/** Nothing about a logo depends on the request, so the handler must not be statically evaluated. */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
): Promise<Response> {
  const { symbol: raw } = await context.params;
  const symbol = normalizeLogoSymbol(raw ?? "");

  if (!isSafeLogoSymbol(symbol)) {
    return new Response("Invalid symbol", { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(providerLogoUrl(symbol), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // The host is fixed; a redirect is the one way the provider could send the proxy elsewhere.
      redirect: "error",
    });
  } catch {
    // The provider is unreachable, slow, or redirected. Never cached: this says nothing about the
    // security, only about this moment, and a cached 502 would keep a mark missing long after it
    // recovered.
    return upstreamFailure();
  }

  // Only a definite "not found" is a miss. A 5xx, a throttle or any other status is the provider
  // failing, and caching it as a miss for an hour would hide a mark that exists.
  if (!upstream.ok && !MISSING_UPSTREAM_STATUSES.has(upstream.status)) {
    discard(upstream);
    return upstreamFailure();
  }

  // A non-image 200 is a miss, not a success. The provider answers some unknown symbols with an
  // HTML page; passing that through would cache an error page as this security's mark, and the
  // `<img>` would fail to decode on every surface until it expired.
  const imageType = imageTypeOf(upstream);
  if (!upstream.ok || imageType === null) {
    discard(upstream);
    return missingLogo();
  }

  const body = await readBounded(upstream, MAX_LOGO_BYTES);
  if (body === null) {
    return upstreamFailure();
  }
  return new Response(body, {
    status: 200,
    headers: {
      // The provider's own type: it serves SVG for some marks and PNG for most.
      "Content-Type": imageType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": CACHE_CONTROL,
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}

/**
 * "This security has no mark" (UX-005): `204 No Content`, cached like any miss.
 *
 * Not a `404`. Chromium logs every `4xx` image as "Failed to load resource" in the console — on
 * every logo-less row of every page, and again for each cached copy — which buries real errors
 * and trips error monitoring for something that is not an error. A `204` is a success status: the
 * browser records no failed resource and no console error, yet an `<img>` still cannot decode an
 * empty body, so it fires `error` and settles `complete` with `naturalWidth === 0` — exactly what
 * `StockLogo` turns into the monogram, on a first load and from the HTTP cache alike. Verified in
 * Chromium for the PR that introduced this.
 */
function missingLogo(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": MISSING_CACHE_CONTROL,
      ...IMAGE_SECURITY_HEADERS,
    },
  });
}

function upstreamFailure(): Response {
  return new Response("Failed to fetch logo", {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Releases an upstream body the route will not read; a failure to do so changes nothing. */
function discard(upstream: Response): void {
  upstream.body?.cancel().catch(() => undefined);
}

/** The upstream content type, but only when it really is an image. */
function imageTypeOf(upstream: Response): string | null {
  const type = upstream.headers.get("content-type");
  return type !== null && type.startsWith("image/") ? type : null;
}

/**
 * The upstream body, or null once it exceeds `limit` bytes — refused from the declared length
 * before reading anything, and otherwise by counting while streaming, so an oversized or
 * mis-declared body is abandoned at the limit rather than buffered whole.
 */
async function readBounded(
  upstream: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    discard(upstream);
    return null;
  }
  if (upstream.body === null) {
    return new Uint8Array(new ArrayBuffer(0));
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // The stream failed mid-body (reset, timeout): the same "provider failed" outcome.
    return null;
  }

  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
