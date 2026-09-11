import type {
  BenchmarkDailyPrice,
  DailyPrice,
  DateRange,
  SecurityListingCandidate,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
  Security,
  SecurityProfile,
} from "@intrinsic/domain";
import {
  BALANCE_SHEET_FIELDS,
  CASH_FLOW_FIELDS,
  INCOME_STATEMENT_FIELDS,
} from "@intrinsic/domain";

export type FmpProfileDto = {
  symbol?: unknown;
  companyName?: unknown;
  exchange?: unknown;
  exchangeFullName?: unknown;
  currency?: unknown;
  cik?: unknown;
  isin?: unknown;
  cusip?: unknown;
  country?: unknown;
  sector?: unknown;
  industry?: unknown;
  ipoDate?: unknown;
  isEtf?: unknown;
  isFund?: unknown;
  isAdr?: unknown;
  isActivelyTrading?: unknown;
  description?: unknown;
  website?: unknown;
  image?: unknown;
  ceo?: unknown;
  fullTimeEmployees?: unknown;
  address?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
};

/**
 * One row of the bulk company screener, which is the only stable FMP endpoint that returns the
 * whole listed universe together with the equity/exchange discriminators the catalog needs.
 * The unused screener fields (market cap, beta, price, volume, dividend) are deliberately absent:
 * catalog synchronization carries identity only, never market data.
 */
export type FmpStockUniverseDto = {
  symbol?: unknown;
  companyName?: unknown;
  /** Full venue name, e.g. "NASDAQ Global Select". */
  exchange?: unknown;
  /** Short venue code, e.g. "NASDAQ". This is the code the catalog stores. */
  exchangeShortName?: unknown;
  country?: unknown;
  sector?: unknown;
  industry?: unknown;
  isEtf?: unknown;
  isFund?: unknown;
  isActivelyTrading?: unknown;
};

/** A universe row paired with the provider identity the catalog upserts on. */
export type MappedFmpSecurityListing = {
  providerSymbol: string;
  listing: SecurityListingCandidate;
};

export type FmpDailyPriceDto = {
  date?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
  vwap?: unknown;
};

/**
 * One row of the batch quote endpoint — the provider's current market snapshot for a symbol.
 *
 * Only the fields a provisional current-day observation needs are declared. A quote carries a lot
 * of derived analytics (change percent, averages, market cap, ranges); none of it is mapped,
 * because every derived series in this product is calculated from canonical bars rather than taken
 * from the provider.
 */
export type FmpQuoteDto = {
  symbol?: unknown;
  price?: unknown;
  open?: unknown;
  dayHigh?: unknown;
  dayLow?: unknown;
  previousClose?: unknown;
  volume?: unknown;
  /** Seconds since the epoch, as the provider reports it. */
  timestamp?: unknown;
};

/**
 * A current market observation for one symbol, as the provider reported it.
 *
 * It is deliberately **not** a `DailyPrice`: it carries no `securityId`, no trading date and no
 * claim to be a closed bar. Turning it into a provisional current-day observation is
 * `@intrinsic/stock-data`'s decision, because only that layer knows the security's persisted
 * history and can say which trading day the quote belongs to.
 */
export type FmpCurrentQuote = {
  providerSymbol: string;
  /** Current traded price. */
  price: number;
  open?: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose?: number;
  volume?: number;
  /** When the provider last updated this quote. Absent when the provider did not report it. */
  quotedAt?: string;
};

export type MappedFmpProfile = {
  providerSymbol: string;
  security: Omit<Security, "id">;
  profile: Omit<SecurityProfile, "securityId">;
};

type FmpFinancialStatementDto = {
  symbol?: unknown;
  date?: unknown;
  reportedCurrency?: unknown;
  cik?: unknown;
  filingDate?: unknown;
  acceptedDate?: unknown;
  fiscalYear?: unknown;
  period?: unknown;
} & Record<string, unknown>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "null") {
    return undefined;
  }
  return normalized;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return parsed;
}

function employees(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = finiteNumber(value, "fullTimeEmployees");
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid FMP fullTimeEmployees");
  }
  return parsed;
}

function localDate(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new Error(`Invalid FMP ${field}`);
  }
  return parsed;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "string" && value.trim().toLowerCase() === "null") {
    return undefined;
  }
  return finiteNumber(value, field);
}

function fiscalYear(value: unknown): number {
  const parsed = finiteNumber(value, "fiscalYear");
  if (!Number.isInteger(parsed)) {
    throw new Error("Invalid FMP fiscalYear");
  }
  return parsed;
}

function financialPeriod(value: unknown): FinancialStatementDraft["period"] {
  const parsed = requiredString(value, "period").toUpperCase();
  if (
    parsed !== "FY" &&
    parsed !== "Q1" &&
    parsed !== "Q2" &&
    parsed !== "Q3" &&
    parsed !== "Q4"
  ) {
    throw new Error("Invalid FMP period");
  }
  return parsed;
}

function mapFinancialValues<T extends readonly string[]>(
  row: FmpFinancialStatementDto,
  fields: T,
): Record<string, number> {
  const mapped: Record<string, number> = {};
  for (const field of fields) {
    const value = optionalNumber(row[field], field);
    if (value !== undefined) {
      mapped[field] = value;
    }
  }
  return mapped;
}

function mapFmpFinancialStatementRows<T extends FinancialStatementType>(input: {
  securityId: string;
  statementType: T;
  rows: readonly FmpFinancialStatementDto[];
  fields: readonly string[];
}): FinancialStatementDraft<T>[] {
  return input.rows.map((row) => {
    requiredString(row.symbol, "financial statement symbol");
    const period = financialPeriod(row.period);
    return {
      securityId: input.securityId,
      statementType: input.statementType,
      fiscalDate: localDate(row.date, "financial statement date"),
      fiscalYear: fiscalYear(row.fiscalYear),
      period,
      reportedCurrency: requiredString(
        row.reportedCurrency,
        "reportedCurrency",
      ),
      filingDate: localDate(row.filingDate, "filingDate"),
      ...(typeof row.acceptedDate === "string" && row.acceptedDate.trim()
        ? { providerAcceptedDate: row.acceptedDate.trim() }
        : {}),
      values: mapFinancialValues(
        row,
        input.fields,
      ) as FinancialStatementDraft<T>["values"],
    };
  });
}

export function normalizeFmpPercentage(
  value: number | string | null | undefined,
  sourceUnit: "DECIMAL" | "PERCENT_POINTS",
): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = finiteNumber(value, "percentage");
  return sourceUnit === "PERCENT_POINTS" ? parsed / 100 : parsed;
}

export function mapFmpProfile(dto: FmpProfileDto): MappedFmpProfile {
  const symbol = requiredString(dto.symbol, "profile symbol").toUpperCase();
  const exchangeCode = requiredString(dto.exchange, "profile exchange");
  const addressCountry = optionalString(dto.country);

  return {
    providerSymbol: symbol,
    security: {
      symbol,
      name: requiredString(dto.companyName, "profile companyName"),
      exchangeCode,
      exchangeName: optionalString(dto.exchangeFullName),
      currency: requiredString(dto.currency, "profile currency"),
      cik: optionalString(dto.cik),
      isin: optionalString(dto.isin),
      cusip: optionalString(dto.cusip),
      country: addressCountry,
      sector: optionalString(dto.sector),
      industry: optionalString(dto.industry),
      ipoDate: optionalString(dto.ipoDate),
      type: boolean(dto.isEtf, false)
        ? "ETF"
        : boolean(dto.isFund, false)
          ? "FUND"
          : "STOCK",
      isAdr: boolean(dto.isAdr, false),
      isActivelyTrading: boolean(dto.isActivelyTrading, true),
    },
    profile: {
      description: optionalString(dto.description),
      website: optionalString(dto.website),
      logoUrl: optionalString(dto.image),
      ceo: optionalString(dto.ceo),
      employees: employees(dto.fullTimeEmployees),
      address: {
        street: optionalString(dto.address),
        city: optionalString(dto.city),
        state: optionalString(dto.state),
        postalCode: optionalString(dto.zip),
        country: addressCountry,
      },
    },
  };
}

/**
 * Maps bulk universe rows, dropping only rows that carry no usable symbol or name.
 *
 * Product admission (stock-only, supported exchange) is not decided here: that is a domain policy,
 * and the provider package must not own it.
 */
export function mapFmpStockUniverse(
  rows: readonly FmpStockUniverseDto[],
): MappedFmpSecurityListing[] {
  const listings: MappedFmpSecurityListing[] = [];
  for (const row of rows) {
    const symbol = optionalString(row.symbol)?.toUpperCase();
    const name = optionalString(row.companyName);
    if (!symbol || !name) {
      continue;
    }
    const exchangeName = optionalString(row.exchange);
    const country = optionalString(row.country);
    const sector = optionalString(row.sector);
    const industry = optionalString(row.industry);
    listings.push({
      providerSymbol: symbol,
      listing: {
        symbol,
        name,
        exchangeCode: optionalString(row.exchangeShortName) ?? "",
        ...(exchangeName ? { exchangeName } : {}),
        ...(country ? { country } : {}),
        ...(sector ? { sector } : {}),
        ...(industry ? { industry } : {}),
        isEtf: boolean(row.isEtf, false),
        isFund: boolean(row.isFund, false),
        // A universe row that omits the flag is assumed tradable; only an explicit `false`
        // deactivates a catalog entry.
        isActivelyTrading: boolean(row.isActivelyTrading, true),
      },
    });
  }
  return listings;
}

export function mapFmpDailyPrices(
  securityId: string,
  rows: readonly FmpDailyPriceDto[],
): DailyPrice[] {
  return rows
    .map((row) => ({
      securityId,
      date: localDate(row.date, "historical date"),
      open: finiteNumber(row.open, "historical open"),
      high: finiteNumber(row.high, "historical high"),
      low: finiteNumber(row.low, "historical low"),
      close: finiteNumber(row.close, "historical close"),
      volume: finiteNumber(row.volume, "historical volume"),
      ...(row.vwap === null || row.vwap === undefined
        ? {}
        : { vwap: finiteNumber(row.vwap, "historical vwap") }),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * Maps batch quote rows into current observations, dropping rows the provider could not price.
 *
 * A quote without a usable price is skipped rather than throwing: one delisted or halted symbol in
 * a batch must not fail the whole cycle's current-data read for every other symbol. A caller sees
 * the symbol missing from the result and treats it as having no current observation, which is the
 * `NOT_EVALUABLE`-honest outcome rather than a fabricated one.
 *
 * The provider's `timestamp` is seconds since the epoch. A non-finite or out-of-range value yields
 * no `quotedAt` at all, so a caller's staleness check fails closed instead of trusting a bad clock.
 */
export function mapFmpQuotes(
  rows: readonly FmpQuoteDto[],
): FmpCurrentQuote[] {
  const quotes: FmpCurrentQuote[] = [];
  for (const row of rows) {
    const providerSymbol = optionalString(row.symbol)?.toUpperCase();
    const price = finiteOrUndefined(row.price);
    if (!providerSymbol || price === undefined || price <= 0) {
      continue;
    }
    quotes.push({
      providerSymbol,
      price,
      ...optionalField("open", finiteOrUndefined(row.open)),
      ...optionalField("dayHigh", finiteOrUndefined(row.dayHigh)),
      ...optionalField("dayLow", finiteOrUndefined(row.dayLow)),
      ...optionalField("previousClose", finiteOrUndefined(row.previousClose)),
      ...optionalField("volume", finiteOrUndefined(row.volume)),
      ...optionalField("quotedAt", quoteInstant(row.timestamp)),
    });
  }
  return quotes;
}

/**
 * A finite number, or `undefined` for anything else.
 *
 * Deliberately non-throwing, unlike the historical-bar helpers. A quote batch carries many symbols
 * in one response, and this is a *current* market snapshot rather than the point-in-time record:
 * one symbol reporting a null or a string for `volume` must not throw away the current data for
 * every other symbol in the monitored universe. A field that cannot be read is simply absent, which
 * every consumer already treats as "not supplied".
 */
function finiteOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Epoch seconds as an ISO instant, or undefined when the provider's value is not usable. */
function quoteInstant(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const instant = new Date(seconds * 1000);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/**
 * The same provider bars, stamped with a benchmark identity instead of a security identity.
 *
 * A benchmark is not a `Security`, so its rows never enter `DailyPrice`. What is shared is the
 * provider response shape and the mapping rules — duplicating those would be the real mistake.
 */
export function mapFmpBenchmarkDailyPrices(
  seriesId: string,
  rows: readonly FmpDailyPriceDto[],
): BenchmarkDailyPrice[] {
  return mapFmpDailyPrices(seriesId, rows).map((row) => ({
    seriesId,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

export function financialStatementPath(
  statementType: FinancialStatementType,
): string {
  switch (statementType) {
    case "INCOME":
      return "income-statement";
    case "BALANCE_SHEET":
      return "balance-sheet-statement";
    case "CASH_FLOW":
      return "cash-flow-statement";
  }
}

function statementFields(
  statementType: FinancialStatementType,
): readonly string[] {
  switch (statementType) {
    case "INCOME":
      return INCOME_STATEMENT_FIELDS;
    case "BALANCE_SHEET":
      return BALANCE_SHEET_FIELDS;
    case "CASH_FLOW":
      return CASH_FLOW_FIELDS;
  }
}

export function mapFmpFinancialStatements<
  T extends FinancialStatementType,
>(input: {
  securityId: string;
  statementType: T;
  rows: readonly FmpFinancialStatementDto[];
}): FinancialStatementDraft<T>[] {
  return mapFmpFinancialStatementRows({
    securityId: input.securityId,
    statementType: input.statementType,
    rows: input.rows,
    fields: statementFields(input.statementType),
  });
}

/**
 * Bulk catalog capability, kept separate from {@link FmpStockProviderPort}.
 *
 * Catalog synchronization is an admin write path with one caller; the per-stock read path has
 * several implementations and fakes. Splitting the ports keeps each side depending only on what
 * it actually uses.
 */
export type FmpSecurityCatalogPort = {
  /** Every listing on one exchange. Never one request per symbol. */
  getStockUniverse(exchangeCode: string): Promise<MappedFmpSecurityListing[]>;
};

/**
 * Benchmark market data, kept as its own port.
 *
 * A benchmark has no profile and no fundamentals; splitting the port keeps a benchmark loader
 * depending only on the one call it makes, exactly as `FmpSecurityCatalogPort` is split out.
 */
export type FmpBenchmarkProviderPort = {
  getBenchmarkDailyPrices(
    providerSymbol: string,
    seriesId: string,
    range: DateRange,
  ): Promise<BenchmarkDailyPrice[]>;
};

/**
 * Current market data, kept as its own port.
 *
 * Monitor evaluation needs only this one call, and it is the only provider read in the product
 * that is not point-in-time history. Splitting it out keeps a current-data loader — and its fakes —
 * depending on one method, exactly as the catalog and benchmark ports are split out.
 */
export type FmpCurrentQuoteProviderPort = {
  /** One request for many symbols. Never one request per symbol, and never one per Monitor. */
  getCurrentQuotes(providerSymbols: readonly string[]): Promise<FmpCurrentQuote[]>;
};

export type FmpStockProviderPort = {
  getProfile(symbol: string): Promise<MappedFmpProfile | null>;
  getDailyPrices(
    symbol: string,
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]>;
  getFinancialStatements(
    symbol: string,
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    limit: number,
  ): Promise<FinancialStatementDraft[]>;
};
