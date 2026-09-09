/**
 * The canonical securities the QA-MATRIX stock-list fixtures are built from.
 *
 * These are **real catalog identities**, not invented tickers. `Security` is the identity
 * authority for list membership (`ai/product/lists.md`), so a matrix list that referenced a
 * fictional production symbol would exercise a universe the product could never resolve. The
 * deliberately fictional `QATEST*` rows seeded by `pnpm test:securities:seed` stay what they are —
 * identity-only fixtures for the Stock Details and Lists browser journeys — and the matrix does
 * not reuse them: it needs decades of real listing history and a thirty-name universe, which is
 * exactly what a fictional row cannot provide.
 *
 * Every field here was read from the synchronized catalog, and every symbol is one the development
 * database already carries daily price history for, so the future matrix runner can hydrate the
 * test database for these names and nothing else.
 *
 * `listedOn` is the provider's own IPO date. It is intent metadata for the fixture documentation —
 * it is what makes "old securities with full history" and "later listings" checkable claims rather
 * than assertions — and the seeder writes it onto a row it creates. It is never a substitute for
 * the price coverage a run actually reads.
 */
export type QaMatrixSecurity = {
  readonly symbol: string;
  readonly name: string;
  readonly exchangeCode: "NASDAQ" | "NYSE";
  readonly exchangeName: string;
  readonly currency: "USD";
  readonly type: "STOCK";
  readonly isAdr: false;
  readonly isActivelyTrading: true;
  /** The provider's IPO date, `YYYY-MM-DD`. */
  readonly listedOn: string;
  /**
   * `FULL_HORIZON` listed long before the thirty-year product horizon opens, so a 30y run sees it
   * on its first simulated day. `LATER_LISTING` listed inside the horizon, so its early years are
   * `NOT_EVALUABLE` and it becomes tradeable only on its own first eligible date.
   */
  readonly coverage: "FULL_HORIZON" | "LATER_LISTING";
};

const NASDAQ = {
  exchangeCode: "NASDAQ",
  exchangeName: "NASDAQ Global Select",
} as const;
const NYSE = {
  exchangeCode: "NYSE",
  exchangeName: "New York Stock Exchange",
} as const;
const COMMON = {
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
} as const;

export const QA_MATRIX_SECURITIES = [
  // Listed decades before the horizon: present from the first simulated day of a 30-year run.
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1980-12-12",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "ADBE",
    name: "Adobe Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1986-08-13",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "AMGN",
    name: "Amgen Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1983-06-17",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "AXP",
    name: "American Express Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1972-06-01",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "BA",
    name: "The Boeing Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1962-01-02",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "CAT",
    name: "Caterpillar Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1929-12-02",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "CSCO",
    name: "Cisco Systems, Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1990-02-16",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "CVX",
    name: "Chevron Corporation",
    ...NYSE,
    ...COMMON,
    listedOn: "1921-06-24",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "DIS",
    name: "The Walt Disney Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1957-11-12",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "HD",
    name: "The Home Depot, Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1981-09-22",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "IBM",
    name: "International Business Machines Corporation",
    ...NYSE,
    ...COMMON,
    listedOn: "1915-09-24",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "JNJ",
    name: "Johnson & Johnson",
    ...NYSE,
    ...COMMON,
    listedOn: "1962-01-02",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "JPM",
    name: "JPMorgan Chase & Co.",
    ...NYSE,
    ...COMMON,
    listedOn: "1980-03-17",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "KO",
    name: "The Coca-Cola Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1962-01-02",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "MCD",
    name: "McDonald's Corporation",
    ...NYSE,
    ...COMMON,
    listedOn: "1965-04-21",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "MMM",
    name: "3M Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1946-01-14",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "MRK",
    name: "Merck & Co., Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1978-01-13",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "MSFT",
    name: "Microsoft Corporation",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1986-03-13",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "NKE",
    name: "NIKE, Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1980-12-02",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "PG",
    name: "The Procter & Gamble Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1978-01-13",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "SHW",
    name: "The Sherwin-Williams Company",
    ...NYSE,
    ...COMMON,
    listedOn: "1980-03-17",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "TRV",
    name: "The Travelers Companies, Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1975-11-17",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "UNH",
    name: "UnitedHealth Group Incorporated",
    ...NYSE,
    ...COMMON,
    listedOn: "1984-10-17",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "WMT",
    name: "Walmart Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1972-08-25",
    coverage: "FULL_HORIZON",
  },
  {
    symbol: "XOM",
    name: "Exxon Mobil Corporation",
    ...NYSE,
    ...COMMON,
    listedOn: "1978-01-13",
    coverage: "FULL_HORIZON",
  },
  // Listed inside the thirty-year horizon: a 30y run starts before they exist.
  {
    symbol: "AMZN",
    name: "Amazon.com, Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1997-05-15",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    ...NASDAQ,
    ...COMMON,
    listedOn: "1999-01-22",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "GS",
    name: "The Goldman Sachs Group, Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "1999-05-04",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "HON",
    name: "Honeywell International Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "2001-02-21",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "CRM",
    name: "Salesforce, Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "2004-06-23",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "GOOGL",
    name: "Alphabet Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "2004-08-19",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "V",
    name: "Visa Inc.",
    ...NYSE,
    ...COMMON,
    listedOn: "2008-03-19",
    coverage: "LATER_LISTING",
  },
  {
    symbol: "MRNA",
    name: "Moderna, Inc.",
    ...NASDAQ,
    ...COMMON,
    listedOn: "2018-12-07",
    coverage: "LATER_LISTING",
  },
] as const satisfies readonly QaMatrixSecurity[];

export type QaMatrixSymbol = (typeof QA_MATRIX_SECURITIES)[number]["symbol"];

const BY_SYMBOL = new Map<string, QaMatrixSecurity>(
  QA_MATRIX_SECURITIES.map((security) => [security.symbol, security]),
);

/** The fixture identity for one matrix symbol; throws for a symbol outside the universe. */
export function qaMatrixSecurity(symbol: QaMatrixSymbol): QaMatrixSecurity {
  const security = BY_SYMBOL.get(symbol);
  if (!security) {
    throw new Error(`\`${symbol}\` is not a QA-MATRIX security`);
  }
  return security;
}
