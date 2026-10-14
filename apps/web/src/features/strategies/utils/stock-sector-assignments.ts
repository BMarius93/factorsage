import type { StockSectorAssignmentResponse } from "@intrinsic/contracts";

/**
 * How Stock's Sector rules were read, per stock, in words — the one place a completed backtest and a
 * Monitor say it, so both say it the same way.
 *
 * `resolved` groups the stocks by the sector ETF they read (`AAPL and MSFT read XLK`); `unresolved`
 * names each stock whose FMP sector is missing or not one of the eleven and why, because its
 * Stock's Sector rules were not evaluable — never read from another fund.
 */
export type StockSectorSummary = {
  /** `AAPL and MSFT read XLK, JPM reads XLF`, or null when no stock resolved. */
  readonly resolved: string | null;
  /** `QATEST1 (no FMP sector) and FOO (“Shell Companies” is not one of the eleven)`, or null. */
  readonly unresolved: string | null;
  readonly unresolvedCount: number;
};

/** At most this many symbols are named per fund; the rest are counted. */
const NAMED_PER_GROUP = 6;

/** `A`, `A and B`, `A, B and C`. */
export function listOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function symbolsOf(symbols: readonly string[]): string {
  if (symbols.length <= NAMED_PER_GROUP) {
    return listOf(symbols);
  }
  const rest = symbols.length - NAMED_PER_GROUP;
  return `${symbols.slice(0, NAMED_PER_GROUP).join(", ")} and ${rest} more`;
}

export function summarizeStockSectors(
  assignments: readonly StockSectorAssignmentResponse[],
): StockSectorSummary {
  const byTicker = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const assignment of assignments) {
    if (assignment.ticker) {
      const symbols = byTicker.get(assignment.ticker) ?? [];
      symbols.push(assignment.symbol);
      byTicker.set(assignment.ticker, symbols);
    } else {
      unresolved.push(
        assignment.sector
          ? `${assignment.symbol} (“${assignment.sector}” is not one of the eleven sectors)`
          : `${assignment.symbol} (no FMP sector)`,
      );
    }
  }
  const groups = [...byTicker.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([ticker, symbols]) =>
        `${symbolsOf(symbols)} ${symbols.length === 1 ? "reads" : "read"} ${ticker}`,
    );
  return {
    resolved: groups.length > 0 ? groups.join(", ") : null,
    unresolved: unresolved.length > 0 ? symbolsOf(unresolved) : null,
    unresolvedCount: unresolved.length,
  };
}
