import {
  findStrategyEtfSource,
  type StrategyEtfSourceCode,
} from "./strategy-etf-sources.js";

/**
 * The one canonical mapping from a stock's FMP sector to the Select Sector SPDR ETF a
 * `Stock's Sector` condition reads (`docs/decisions/strategy-etf-conditions-v1.md`, Stock's Sector).
 *
 * The sector is the classification FMP gives the company and `Security.sector` stores — written by
 * the catalog synchronization and by a profile hydration alike. These are FMP's eleven sector names
 * exactly as it spells them; an audit of every stored security on 2026-10-14 (9,766 classified of
 * 9,768) found these eleven strings and nothing else, so there is no alias table: a value that is
 * not one of them after trimming and case-folding is **unsupported**, never guessed at. No sector is
 * ever derived from a ticker, an industry or a name.
 *
 * The product accepts that this is the stock's **current** classification, applied to every date of
 * a backtest and every Monitor scan — there is no historical sector record.
 */
export const FMP_STOCK_SECTORS = [
  "Technology",
  "Financial Services",
  "Energy",
  "Healthcare",
  "Industrials",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Utilities",
  "Basic Materials",
  "Real Estate",
  "Communication Services",
] as const;

export type FmpStockSector = (typeof FMP_STOCK_SECTORS)[number];

/** Each FMP sector's sector ETF, by the stable benchmark code the ETF catalog stores. */
export const STOCK_SECTOR_ETF_CODES = {
  Technology: "ETF_XLK",
  "Financial Services": "ETF_XLF",
  Energy: "ETF_XLE",
  Healthcare: "ETF_XLV",
  Industrials: "ETF_XLI",
  "Consumer Cyclical": "ETF_XLY",
  "Consumer Defensive": "ETF_XLP",
  Utilities: "ETF_XLU",
  "Basic Materials": "ETF_XLB",
  "Real Estate": "ETF_XLRE",
  "Communication Services": "ETF_XLC",
} as const satisfies Record<FmpStockSector, StrategyEtfSourceCode>;

/** How one stored sector resolved. */
export type StockSectorResolution =
  /** One of the eleven, and the sector ETF it maps to. */
  | {
      readonly status: "RESOLVED";
      readonly sector: FmpStockSector;
      readonly code: StrategyEtfSourceCode;
    }
  /** The security has no stored sector. */
  | { readonly status: "MISSING" }
  /** A stored value that is not one of FMP's eleven sectors. */
  | { readonly status: "UNSUPPORTED"; readonly sector: string };

/** Lower case with inner whitespace collapsed: the only normalization applied before matching. */
function comparable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const SECTOR_BY_COMPARABLE = new Map<string, FmpStockSector>(
  FMP_STOCK_SECTORS.map((sector) => [comparable(sector), sector]),
);

/**
 * Resolves a stored FMP sector to its sector ETF, or says why it cannot.
 *
 * Exact match on FMP's own names, insensitive to case and surrounding or repeated whitespace — the
 * one tolerance a stored string can need — and nothing else: `Financial`, `Health Care` or a GICS
 * name are unsupported, because none appears in the data and inventing their meaning would be
 * guessing. A condition reading an unresolved sector is `NOT_EVALUABLE`; it never falls back to
 * another ETF.
 */
export function resolveStockSectorEtf(
  sector: string | null | undefined,
): StockSectorResolution {
  if (sector === null || sector === undefined || sector.trim() === "") {
    return { status: "MISSING" };
  }
  const canonical = SECTOR_BY_COMPARABLE.get(comparable(sector));
  return canonical
    ? {
        status: "RESOLVED",
        sector: canonical,
        code: STOCK_SECTOR_ETF_CODES[canonical],
      }
    : { status: "UNSUPPORTED", sector: sector.trim() };
}

/** The sector ETF's ticker for a resolved code: `XLK`. */
export function stockSectorEtfTicker(code: StrategyEtfSourceCode): string {
  return findStrategyEtfSource(code)?.ticker ?? code;
}

/**
 * Which sector ETF one stock's `Stock's Sector` rules read, for a surface that has to say so: a
 * completed backtest (as its snapshot froze it) or a Monitor (as the stock is classified now).
 * `code` and `ticker` are null when the sector is missing or unsupported — the stock's Stock's
 * Sector rules were then not evaluable, never read from another fund.
 */
export type StockSectorAssignmentResponse = {
  symbol: string;
  /** The stored FMP sector, or null when the stock has none. */
  sector: string | null;
  code: string | null;
  ticker: string | null;
};

/** The assignment a resolution means for one stock. */
export function stockSectorAssignment(
  symbol: string,
  sector: string | null | undefined,
): StockSectorAssignmentResponse {
  const resolution = resolveStockSectorEtf(sector);
  return {
    symbol,
    sector: sector?.trim() ? sector.trim() : null,
    code: resolution.status === "RESOLVED" ? resolution.code : null,
    ticker:
      resolution.status === "RESOLVED"
        ? stockSectorEtfTicker(resolution.code)
        : null,
  };
}
