/**
 * Where a security's mark comes from.
 *
 * One rule for the whole product: a company logo is served from FactorSage's own
 * `/api/logo/{ticker}` endpoint and never from a provider URL in the browser. That single
 * indirection is what buys four separate things, and all four are the reason this module exists
 * rather than an `<img src={security.logoUrl}>` at each call site:
 *
 * - **One cache entry per security.** The URL is derived from the ticker alone, so the mark a
 *   search row loaded is the same HTTP cache entry the list row, the monitor row and the Stock
 *   Details header ask for. With the long `Cache-Control` the route sets, navigating the product
 *   re-reads them from cache instead of visibly re-fetching a logo per screen.
 * - **Same-origin pixels.** `StockLogo` samples the loaded image on a canvas to find near-white
 *   marks that would vanish on a white surface. A cross-origin image taints that canvas and the
 *   sample is refused; a same-origin one does not.
 * - **One place that knows the provider.** Only the route handler builds an upstream image URL.
 *   Nothing under `features/` or `components/` names an image host.
 * - **A mark for securities the catalog has not profiled.** `SecurityProfile` rows — and so the
 *   contracts' `logoUrl` — exist only for securities something has hydrated, which is a small
 *   fraction of the catalog. The endpoint is keyed by ticker, so a list member nobody has opened
 *   still gets a real logo, and a ticker with no mark upstream falls back to the monogram after
 *   one cached miss.
 */

/**
 * Tickers the logo endpoint will serve.
 *
 * Deliberately narrow — upper-case letters, digits, dot and dash — because this value is
 * interpolated into an upstream request path. Anything else is refused rather than escaped, here
 * and again in the route, so the browser never issues a request the server will reject.
 */
export const SAFE_LOGO_SYMBOL = /^[A-Z0-9.-]{1,20}$/;

/** The ticker as the logo endpoint addresses it. */
export function normalizeLogoSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Whether `/api/logo/{symbol}` will accept this ticker. Expects an already normalized value. */
export function isSafeLogoSymbol(symbol: string): boolean {
  return SAFE_LOGO_SYMBOL.test(symbol);
}

/** The product's own URL for one security's mark. */
export function stockLogoLocation(symbol: string): string {
  return `/api/logo/${encodeURIComponent(symbol)}`;
}

/**
 * The image a security's mark should load, or `undefined` when there is nothing to try.
 *
 * `logoUrl` is the persisted mark from `SecurityProfile` as the API projects it. It is not what
 * the browser loads: the endpoint above is, because a ticker-keyed same-origin URL is what makes
 * the mark cacheable across surfaces and samplable on a canvas. It is still the honest fallback
 * for the one case the endpoint cannot serve — a ticker outside `SAFE_LOGO_SYMBOL` — where a
 * cross-origin image is better than no image, at the cost of the brightness check.
 *
 * `undefined` means "render the monogram and issue no request at all".
 */
export function stockLogoSrc(
  symbol: string,
  logoUrl?: string,
): string | undefined {
  const ticker = normalizeLogoSymbol(symbol);
  if (isSafeLogoSymbol(ticker)) {
    return stockLogoLocation(ticker);
  }
  return logoUrl === undefined || logoUrl === "" ? undefined : logoUrl;
}
