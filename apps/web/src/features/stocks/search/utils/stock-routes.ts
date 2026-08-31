/** Canonical destination for a security, shared by every stock-search selection path. */
export function stockDetailsHref(symbol: string): string {
  return `/stocks/${encodeURIComponent(symbol.trim().toUpperCase())}`;
}
