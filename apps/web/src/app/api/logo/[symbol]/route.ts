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
    });
  } catch {
    // The provider is unreachable or slow. Never cached: this says nothing about the security,
    // only about this moment, and a cached 502 would keep a mark missing long after it recovered.
    return new Response("Failed to fetch logo", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // A non-image 200 is a miss, not a success. The provider answers some unknown symbols with an
  // HTML page; passing that through would cache an error page as this security's mark, and the
  // `<img>` would fail to decode on every surface until it expired.
  const imageType = imageTypeOf(upstream);
  if (!upstream.ok || imageType === null) {
    return new Response("Logo not found", {
      status: 404,
      headers: { "Cache-Control": MISSING_CACHE_CONTROL },
    });
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      // The provider's own type: it serves SVG for some marks and PNG for most.
      "Content-Type": imageType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": CACHE_CONTROL,
    },
  });
}

/** The upstream content type, but only when it really is an image. */
function imageTypeOf(upstream: Response): string | null {
  const type = upstream.headers.get("content-type");
  return type !== null && type.startsWith("image/") ? type : null;
}
