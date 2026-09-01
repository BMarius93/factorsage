/**
 * Normalizes the raw `/stocks/[symbol]` route parameter into the canonical ticker form the API
 * expects, so a direct visit to `/stocks/aapl` and a search selection behave identically.
 */
export function normalizeStockSymbol(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape sequence falls through as-is; the API will reject it as unknown.
  }
  return decoded.trim().toUpperCase();
}
