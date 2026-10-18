import type {
  BenchmarkDailyPrice,
  CongressAssetClass,
  CongressChamber,
  CongressOwner,
  CongressTransactionKind,
  DailyPrice,
  DateRange,
  SecurityListingCandidate,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
  InsiderRole,
  InsiderTransactionCategory,
  Security,
  SecurityProfile,
  StockSplit,
} from "@intrinsic/domain";
import {
  alternativeDataAvailabilityDate,
  BALANCE_SHEET_FIELDS,
  CASH_FLOW_FIELDS,
  classifyCongressAssetClass,
  classifyCongressOwner,
  classifyCongressTransaction,
  classifyInsiderTransaction,
  INCOME_STATEMENT_FIELDS,
  insiderRolesOf,
  insiderTransactionCode,
  insiderTransactionValue,
  parseDisclosedAmountRange,
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
 * One row of the exchange holiday schedule.
 *
 * Only the fields that decide whether the venue opens are declared. The provider also returns the
 * holiday's name and adjusted session times; the name is mapped for diagnostics and the times are
 * not, because an adjusted session is still a session and this boundary answers one question only.
 */
export type FmpExchangeHolidayDto = {
  exchange?: unknown;
  date?: unknown;
  name?: unknown;
  /** `true` on a full closure. An early-close row carries `null` here. */
  isClosed?: unknown;
  /** Present on early-close rows as `false`. Absent on full closures. */
  isFullyClosed?: unknown;
  adjOpenTime?: unknown;
  adjCloseTime?: unknown;
};

/**
 * A scheduled non-standard session on one exchange.
 *
 * `fullClose` is the only thing the product acts on: a fully closed day has no session, while an
 * early close is an ordinary trading day that ends sooner. Both appear in the provider's schedule,
 * so the distinction has to be carried rather than inferred from presence.
 */
export type FmpExchangeHoliday = {
  date: string;
  name?: string;
  fullClose: boolean;
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
  const mapped: FinancialStatementDraft<T>[] = [];
  for (const row of input.rows) {
    requiredString(row.symbol, "financial statement symbol");
    const period = financialPeriod(row.period);
    const fiscalDate = localDate(row.date, "financial statement date");
    // A statement is placed in time by its filing date alone. One the provider sends without a
    // readable filing date cannot be made point-in-time available, so it is left out — never dated
    // from its fiscal date or its acceptance timestamp, which would be a guess — and the rest of the
    // symbol's history is kept. One malformed historical filing must not cost a security its whole
    // fundamentals history, the rule alternative-data rows already follow (`optionalLocalDate`).
    const filingDate = optionalLocalDate(row.filingDate);
    if (!filingDate) {
      continue;
    }
    mapped.push({
      securityId: input.securityId,
      statementType: input.statementType,
      fiscalDate,
      fiscalYear: fiscalYear(row.fiscalYear),
      period,
      reportedCurrency: requiredString(
        row.reportedCurrency,
        "reportedCurrency",
      ),
      filingDate,
      ...(typeof row.acceptedDate === "string" && row.acceptedDate.trim()
        ? { providerAcceptedDate: row.acceptedDate.trim() }
        : {}),
      values: mapFinancialValues(
        row,
        input.fields,
      ) as FinancialStatementDraft<T>["values"],
    });
  }
  return mapped;
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
 * Maps an exchange holiday schedule, skipping rows that carry no usable date.
 *
 * A row is a **full close** only when the provider says so. Anything else that parses is a session:
 * an early close is a trading day, and reading one as a closure would silently stop monitoring a
 * real session.
 *
 * Two fields carry that distinction, verified against the live endpoint on 2026-09-11: a full
 * closure reports `isClosed: true` and no `isFullyClosed`, while an early close reports
 * `isClosed: null` with `isFullyClosed: false` beside its adjusted times. `isFullyClosed` is the
 * more specific of the two, so it decides when present — which also keeps the reading correct if
 * the provider ever emits it on full closures as well.
 *
 * A response that is not a list of rows throws. Judging whether a *parseable* schedule is
 * plausible is the calendar's job, not the mapper's: it is the layer that knows a complete year is
 * being asked for.
 */
export function mapFmpExchangeHolidays(
  rows: readonly FmpExchangeHolidayDto[],
): FmpExchangeHoliday[] {
  if (!Array.isArray(rows)) {
    throw new Error("Invalid FMP exchange holiday schedule");
  }
  const holidays: FmpExchangeHoliday[] = [];
  for (const row of rows) {
    const date = optionalString(row.date);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }
    const name = optionalString(row.name);
    holidays.push({
      date,
      ...(name ? { name } : {}),
      fullClose:
        typeof row.isFullyClosed === "boolean"
          ? row.isFullyClosed
          : row.isClosed === true,
    });
  }
  return holidays.sort((left, right) => left.date.localeCompare(right.date));
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
 * The exchange trading calendar, kept as its own port.
 *
 * It is per *exchange*, never per security: a caller resolves one schedule and shares it across
 * every symbol listed there. Splitting the port keeps a calendar consumer — and its fakes —
 * depending on one method, exactly as the catalog and benchmark ports are split out.
 */
export type FmpExchangeCalendarPort = {
  getExchangeHolidays(
    exchangeCode: string,
    from: string,
    to: string,
  ): Promise<FmpExchangeHoliday[]>;
};

/** One row of `stable/splits`. */
export type FmpStockSplitDto = {
  symbol?: unknown;
  date?: unknown;
  numerator?: unknown;
  denominator?: unknown;
  splitType?: unknown;
};

/**
 * Maps a security's split list.
 *
 * Verified live on 2026-10-01: one row per event, newest first, `numerator : denominator` the share
 * ratio (4:1 for AAPL's 2020 split, 1:10 for a reverse split, 523:500 for IBM's 2021 Kyndryl
 * spin-off), and `splitType` the provider's label — `stock-split`, `stock-dividend` or `spin-off`,
 * the last two rare and the first used for most distributions too. Announced events appear before
 * their date. A response that is not a list throws.
 *
 * A dated row whose ratio is unreadable is kept with ratio `0 : 1`, which no plain share change
 * has: the event is real and placed, and reading it as a possible distribution over-masks, where
 * dropping it would under-mask. A row without a calendar date cannot be placed, and skipping it
 * would under-mask the same way, so it throws as a response that is not a list does.
 */
export function mapFmpStockSplits(
  securityId: string,
  rows: readonly FmpStockSplitDto[],
): StockSplit[] {
  if (!Array.isArray(rows)) {
    throw new Error("Invalid FMP split list");
  }
  const splits: StockSplit[] = [];
  for (const row of rows) {
    const date = optionalString(row.date);
    if (!date || !isCalendarDate(date)) {
      throw new Error("Invalid FMP split date");
    }
    const numerator =
      typeof row.numerator === "number" ? row.numerator : Number(row.numerator);
    const denominator =
      typeof row.denominator === "number"
        ? row.denominator
        : Number(row.denominator);
    const readable =
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      numerator > 0 &&
      denominator > 0;
    splits.push({
      securityId,
      date,
      numerator: readable ? numerator : 0,
      denominator: readable ? denominator : 1,
      label: optionalString(row.splitType) ?? null,
    });
  }
  return splits.sort((left, right) => left.date.localeCompare(right.date));
}

/** `YYYY-MM-DD` that names a real day, so `2023-02-31` is refused rather than rolled over. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * A security's split list, kept as its own port.
 *
 * Only the valuation ratios read it, and only when a Strategy names one, so the per-stock read path
 * and its fakes stay as they are — exactly as the calendar port is split out.
 */
export type FmpStockSplitPort = {
  getStockSplits(symbol: string, securityId: string): Promise<StockSplit[]>;
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

// ---------------------------------------------------------------------------
// Alternative data: insider activity and congressional trading
//
// Provider facts verified live against `https://financialmodelingprep.com/stable/` on 2026-09-25.
// They are recorded here because they are provider knowledge and nothing above this layer may
// depend on them:
//
// - `insider-trading/search` takes `symbol`, `page` and `limit`. `limit` is capped at **1000** (a
//   request for 2000 returns 1000) and `page` is a page index, so page `n` returns rows
//   `n * limit …`. Rows come newest-first by `filingDate`. **`from` and `to` are ignored** — asking
//   for 2024-01-01 → 2024-03-01 returned the same newest rows as no range at all — so a bounded
//   historical read is impossible and ingestion pages backwards until it passes the date it needs.
// - `senate-trades` and `house-trades` take the same three parameters; `limit` is capped at **250**.
//   Rows come newest-first by `disclosureDate`, and **ordering within one disclosure date is not
//   stable between calls**, which is why ingestion is keyed by content digest rather than by
//   position. Both chambers return the member's bioguide id in a field named `senateID`.
// - `senate-profile` is the member directory, and despite its name it holds **both chambers**
//   (verified live on 2026-10-11; `house-profile` answers HTTP 404). It takes `active` and `page`:
//   `active=true` — also the default — returns the members in office, `active=false` the former
//   ones, and no row belongs to both. A page holds at most **500** rows and `page` is a page index;
//   the page after the last is an empty array. That day it held 540 members in office (500 + 40)
//   and 721 former ones (500 + 221): 1,261 distinct identities in four requests. Each row carries
//   the bioguide id in the same `senateID` field the trade endpoints use, so a directory row and a
//   disclosure name one identity. `latestPosition` is the **latest** position only — there is no
//   history — and is `Representative`, `Senator`, or an office outside Congress (`Vice President`,
//   `President`) for somebody who has since left it. There is no nickname or alias field: the
//   directory spells the senator people call Ted Cruz "Rafael Edward" "Cruz".
//
// Form 13F is deliberately absent. Every `institutional-ownership/*` endpoint answered **HTTP 402
// "Restricted Endpoint"** on this account, so an institutional integration could never have been
// verified against a real payload; V1 ships the two domains this subscription actually provides
// rather than dormant unverified code (`docs/alternative-data-signals.md`).
// ---------------------------------------------------------------------------

/** Symbols per insider-trading page. Verified cap: a larger `limit` still returns 1000 rows. */
export const FMP_INSIDER_TRADING_MAX_PAGE_SIZE = 1000;

/** Rows per congressional-trading page. Verified cap: a larger `limit` still returns 250 rows. */
export const FMP_CONGRESS_TRADING_MAX_PAGE_SIZE = 250;

/** Rows per member-directory page. A page shorter than this is the last one. */
export const FMP_CONGRESS_MEMBER_PROFILE_PAGE_SIZE = 500;

/** One row of `insider-trading/search`. */
export type FmpInsiderTradeDto = {
  symbol?: unknown;
  filingDate?: unknown;
  transactionDate?: unknown;
  reportingCik?: unknown;
  companyCik?: unknown;
  transactionType?: unknown;
  securitiesOwned?: unknown;
  reportingName?: unknown;
  typeOfOwner?: unknown;
  acquisitionOrDisposition?: unknown;
  directOrIndirect?: unknown;
  formType?: unknown;
  securitiesTransacted?: unknown;
  price?: unknown;
  securityName?: unknown;
  url?: unknown;
};

/**
 * One row of `senate-trades` or `house-trades`.
 *
 * `senateID` carries the member's bioguide id on **both** endpoints; the name is the provider's, not
 * a statement about the chamber. `district` is a state code on Senate rows (`AL`) and a
 * state-plus-district string on House rows (`TX17`), and is occasionally empty.
 */
export type FmpCongressTradeDto = {
  symbol?: unknown;
  senateID?: unknown;
  disclosureDate?: unknown;
  transactionDate?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  office?: unknown;
  district?: unknown;
  owner?: unknown;
  assetDescription?: unknown;
  assetType?: unknown;
  type?: unknown;
  amount?: unknown;
  capitalGainsOver200USD?: unknown;
  comment?: unknown;
  link?: unknown;
};

/**
 * One row of `senate-profile`: a member of either chamber, in office or not.
 *
 * `birthDate`, `latestParty`, `image` and `yearsActive` are sent too and deliberately not read:
 * nothing in this product selects, labels or counts by them.
 */
export type FmpCongressMemberProfileDto = {
  senateID?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  latestState?: unknown;
  latestPosition?: unknown;
  active?: unknown;
};

/**
 * One normalized insider transaction, still carrying the provider's raw row.
 *
 * A mapped row is deliberately **not** a `Security`-keyed domain fact yet: the provider answers by
 * symbol and knows nothing of this product's catalog ids, so binding the row to a `securityId` is the
 * caller's job. Everything else — the Form 4 classification, the roles, the availability date and the
 * transacted value — is domain normalization and is applied here through `@intrinsic/domain`.
 */
export type MappedFmpInsiderTrade = {
  providerSymbol: string;
  transactionDate: string;
  filingDate: string;
  availableFromDate: string;
  reportingCik: string;
  reportingName: string;
  companyCik?: string;
  typeOfOwner?: string;
  roles: readonly InsiderRole[];
  transactionCode?: string;
  transactionTypeRaw: string;
  category: InsiderTransactionCategory;
  acquisitionOrDisposition?: string;
  directOrIndirect?: string;
  formType?: string;
  securityName?: string;
  securitiesTransacted?: number;
  securitiesOwned?: number;
  price?: number;
  transactionValue?: number;
  sourceUrl?: string;
  raw: Record<string, unknown>;
};

/**
 * One member of Congress as the directory describes them.
 *
 * An identity and a label, nothing else: a directory row says who somebody is, never that they
 * traded. Only the identifier is required. A row whose name or position this product cannot use is
 * still returned, with that field absent, so the caller can report what it declined and why rather
 * than have it vanish in the mapper.
 */
export type MappedFmpCongressMember = {
  /** The member's bioguide id: the same identity a disclosure row carries in `senateID`. */
  externalId: string;
  /** `firstName lastName`, spelled as the directory spells them. */
  name?: string;
  /** The chamber of the latest position; absent when that position is not a seat in Congress. */
  chamber?: CongressChamber;
  /** The provider's own `latestPosition`, e.g. `Vice President`. */
  positionRaw?: string;
  /** The two-letter state of the latest position. */
  state?: string;
  /** The provider's `active` flag; absent when the row does not state one. */
  inOffice?: boolean;
};

export type MappedFmpCongressTrade = {
  providerSymbol: string;
  chamber: CongressChamber;
  actorExternalId: string;
  actorDisplayName: string;
  actorState?: string;
  actorDistrict?: string;
  transactionDate: string;
  disclosureDate: string;
  availableFromDate: string;
  kind: CongressTransactionKind;
  transactionTypeRaw: string;
  owner: CongressOwner;
  ownerRaw?: string;
  assetClass: CongressAssetClass;
  assetTypeRaw?: string;
  assetDescription?: string;
  amountRangeRaw?: string;
  amountLowerBound?: number;
  amountUpperBound?: number;
  capitalGainsOver200Usd?: boolean;
  comment?: string;
  sourceUrl?: string;
  raw: Record<string, unknown>;
};

/**
 * A provider date that may arrive as `YYYY-MM-DD` or as a timestamp; only the calendar day is kept.
 *
 * Distinct from `localDate` above, which is required-or-throw: an alternative-data row with an
 * unreadable date is skipped by its mapper rather than failing a whole page, because one malformed
 * disclosure must not cost a symbol its entire ingest.
 */
function optionalLocalDate(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Normalizes one page of insider transactions, dropping rows the product cannot place in time.
 *
 * A row is dropped only when it has no transaction date, no filing date or no reporting CIK: without
 * the filing date there is no availability date and the row could not be evaluated point-in-time at
 * all, and without the CIK a distinct-buyer count would have no identity to count. Everything else is
 * kept, including transaction types this product classifies as `OTHER`, because the raw row is the
 * audit trail behind a historical signal.
 */
export function mapFmpInsiderTrades(
  rows: readonly FmpInsiderTradeDto[],
): MappedFmpInsiderTrade[] {
  const mapped: MappedFmpInsiderTrade[] = [];
  for (const row of rows) {
    const providerSymbol = optionalString(row.symbol)?.toUpperCase();
    const transactionDate = optionalLocalDate(row.transactionDate);
    const filingDate = optionalLocalDate(row.filingDate);
    const reportingCik = optionalString(row.reportingCik);
    const transactionTypeRaw = optionalString(row.transactionType);
    if (
      !providerSymbol ||
      !transactionDate ||
      !filingDate ||
      !reportingCik ||
      !transactionTypeRaw
    ) {
      continue;
    }
    const securitiesTransacted = optionalFiniteNumber(row.securitiesTransacted);
    const price = optionalFiniteNumber(row.price);
    const transactionCode = insiderTransactionCode(transactionTypeRaw);
    const transactionValue = insiderTransactionValue({
      ...(securitiesTransacted === undefined ? {} : { securitiesTransacted }),
      ...(price === undefined ? {} : { price }),
    });
    const typeOfOwner = optionalString(row.typeOfOwner);
    const companyCik = optionalString(row.companyCik);
    const acquisitionOrDisposition = optionalString(
      row.acquisitionOrDisposition,
    );
    const directOrIndirect = optionalString(row.directOrIndirect);
    const formType = optionalString(row.formType);
    const securityName = optionalString(row.securityName);
    const securitiesOwned = optionalFiniteNumber(row.securitiesOwned);
    const sourceUrl = optionalString(row.url);
    mapped.push({
      providerSymbol,
      transactionDate,
      filingDate,
      availableFromDate: alternativeDataAvailabilityDate(filingDate),
      reportingCik,
      reportingName: optionalString(row.reportingName) ?? reportingCik,
      ...(companyCik ? { companyCik } : {}),
      ...(typeOfOwner ? { typeOfOwner } : {}),
      roles: insiderRolesOf(typeOfOwner),
      ...(transactionCode ? { transactionCode } : {}),
      transactionTypeRaw,
      category: classifyInsiderTransaction(transactionTypeRaw),
      ...(acquisitionOrDisposition ? { acquisitionOrDisposition } : {}),
      ...(directOrIndirect ? { directOrIndirect } : {}),
      ...(formType ? { formType } : {}),
      ...(securityName ? { securityName } : {}),
      ...(securitiesTransacted === undefined ? {} : { securitiesTransacted }),
      ...(securitiesOwned === undefined ? {} : { securitiesOwned }),
      ...(price === undefined ? {} : { price }),
      ...(transactionValue === undefined ? {} : { transactionValue }),
      ...(sourceUrl ? { sourceUrl } : {}),
      raw: { ...(row as Record<string, unknown>) },
    });
  }
  return mapped;
}

/**
 * Normalizes one page of congressional disclosures for one chamber.
 *
 * The chamber is a parameter rather than something read from the payload, because the payload does
 * not state it: both endpoints return a field called `senateID` and neither says which chamber the
 * row came from. The endpoint that was asked is the only evidence, so the caller supplies it.
 *
 * A row is dropped only when it has no symbol, no transaction date, no disclosure date or no member
 * identifier. Non-stock assets are **kept** and classified; it is the strategy metrics, not
 * ingestion, that count only common stock.
 */
export function mapFmpCongressTrades(
  chamber: CongressChamber,
  rows: readonly FmpCongressTradeDto[],
): MappedFmpCongressTrade[] {
  const mapped: MappedFmpCongressTrade[] = [];
  for (const row of rows) {
    const providerSymbol = optionalString(row.symbol)?.toUpperCase();
    const transactionDate = optionalLocalDate(row.transactionDate);
    const disclosureDate = optionalLocalDate(row.disclosureDate);
    const actorExternalId = optionalString(row.senateID);
    const transactionTypeRaw = optionalString(row.type);
    if (
      !providerSymbol ||
      !transactionDate ||
      !disclosureDate ||
      !actorExternalId ||
      !transactionTypeRaw
    ) {
      continue;
    }
    const firstName = optionalString(row.firstName);
    const lastName = optionalString(row.lastName);
    const office = optionalString(row.office);
    // The display name is a label, so a readable one is preferred and the identifier remains the
    // identity. `office` is the provider's own presentational name ("Tommy Tuberville") and is the
    // most readable; the legal names are the fallback.
    const actorDisplayName =
      office ??
      [firstName, lastName].filter((part) => part).join(" ") ??
      actorExternalId;
    const district = optionalString(row.district);
    const ownerRaw = optionalString(row.owner);
    const assetTypeRaw = optionalString(row.assetType);
    const assetDescription = optionalString(row.assetDescription);
    const amountRangeRaw = optionalString(row.amount);
    const amount = parseDisclosedAmountRange(amountRangeRaw);
    const comment = optionalString(row.comment);
    const sourceUrl = optionalString(row.link);
    const capitalGains = optionalString(row.capitalGainsOver200USD);
    mapped.push({
      providerSymbol,
      chamber,
      actorExternalId,
      actorDisplayName:
        actorDisplayName.trim().length > 0 ? actorDisplayName : actorExternalId,
      // Senate rows carry a bare state code; House rows carry state plus district number.
      ...(district
        ? chamber === "SENATE"
          ? { actorState: district }
          : { actorState: district.slice(0, 2), actorDistrict: district }
        : {}),
      transactionDate,
      disclosureDate,
      availableFromDate: alternativeDataAvailabilityDate(disclosureDate),
      kind: classifyCongressTransaction(transactionTypeRaw),
      transactionTypeRaw,
      owner: classifyCongressOwner(ownerRaw),
      ...(ownerRaw ? { ownerRaw } : {}),
      assetClass: classifyCongressAssetClass(assetTypeRaw),
      ...(assetTypeRaw ? { assetTypeRaw } : {}),
      ...(assetDescription ? { assetDescription } : {}),
      ...(amountRangeRaw ? { amountRangeRaw } : {}),
      ...(amount.lowerBound === undefined
        ? {}
        : { amountLowerBound: amount.lowerBound }),
      ...(amount.upperBound === undefined
        ? {}
        : { amountUpperBound: amount.upperBound }),
      ...(capitalGains === undefined
        ? {}
        : {
            capitalGainsOver200Usd:
              capitalGains.toLowerCase() === "true" ||
              (typeof row.capitalGainsOver200USD === "boolean" &&
                row.capitalGainsOver200USD),
          }),
      ...(comment ? { comment } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      raw: { ...(row as Record<string, unknown>) },
    });
  }
  return mapped;
}

/** The provider's position titles that are a seat in Congress, and the chamber each sits in. */
const CONGRESS_POSITION_CHAMBERS: Readonly<Record<string, CongressChamber>> = {
  representative: "HOUSE",
  senator: "SENATE",
};

/**
 * Normalizes one page of the member directory.
 *
 * A row is dropped only when it carries no identifier, because nothing can be keyed without one.
 * Everything else is kept and described: a position that is not a seat in Congress leaves `chamber`
 * absent rather than guessed, and a state is read only as two letters.
 */
export function mapFmpCongressMemberProfiles(
  rows: readonly FmpCongressMemberProfileDto[],
): MappedFmpCongressMember[] {
  const mapped: MappedFmpCongressMember[] = [];
  for (const row of rows) {
    const externalId = optionalString(row.senateID);
    if (!externalId) {
      continue;
    }
    const name = [optionalString(row.firstName), optionalString(row.lastName)]
      .filter((part) => part)
      .join(" ");
    const positionRaw = optionalString(row.latestPosition);
    const chamber = positionRaw
      ? CONGRESS_POSITION_CHAMBERS[positionRaw.toLowerCase()]
      : undefined;
    const state = optionalString(row.latestState)?.toUpperCase();
    mapped.push({
      externalId,
      ...(name ? { name } : {}),
      ...(chamber ? { chamber } : {}),
      ...(positionRaw ? { positionRaw } : {}),
      ...(state && /^[A-Z]{2}$/.test(state) ? { state } : {}),
      ...(typeof row.active === "boolean" ? { inOffice: row.active } : {}),
    });
  }
  return mapped;
}

/**
 * One page of provider rows, and how many rows the provider actually sent.
 *
 * The two numbers are different and the difference matters. `rows` holds what survived
 * normalization; `providerRowCount` is the length of the payload itself. A caller pages backwards
 * through a newest-first endpoint and decides it has reached the end when a page comes back shorter
 * than the endpoint's cap — and that decision is a statement about the *provider*, never about this
 * product's normalizer.
 *
 * Reading it off `rows.length` was a real defect: `insider-trading/search` returns Form 3 rows with
 * an empty `transactionType`, which the mapper legitimately drops, so a **full** 1,000-row page
 * arrived as 984 mapped rows and every cold ingest stopped after one page. A symbol's whole
 * disclosure history before that page then read NOT_EVALUABLE — not because the provider had
 * nothing, but because sixteen initial-holdings statements were not transactions.
 */
export type FmpProviderPage<T> = {
  /** Rows the provider's payload carried, before any normalization dropped one. */
  providerRowCount: number;
  rows: T[];
};

export type FmpInsiderTradePage = FmpProviderPage<MappedFmpInsiderTrade>;
export type FmpCongressTradePage = FmpProviderPage<MappedFmpCongressTrade>;
export type FmpCongressMemberPage = FmpProviderPage<MappedFmpCongressMember>;

/**
 * Insider Form 4 activity, kept as its own port.
 *
 * One request per symbol and page. The caller decides how far back to page, because only it knows
 * what history the product needs — the endpoint accepts no date range.
 */
export type FmpInsiderTradingPort = {
  getInsiderTrades(input: {
    symbol: string;
    page: number;
    limit: number;
  }): Promise<FmpInsiderTradePage>;
};

/** Congressional disclosures for one chamber, kept as its own port. */
export type FmpCongressTradingPort = {
  getCongressTrades(input: {
    chamber: CongressChamber;
    symbol: string;
    page: number;
    limit: number;
  }): Promise<FmpCongressTradePage>;
};

/**
 * The member directory, kept as its own port.
 *
 * Separate from `FmpCongressTradingPort` on purpose: a directory page is asked for no security and
 * says nothing about a trade, so the loader that ingests disclosures has no way to reach it and the
 * directory synchronization has no way to reach a disclosure.
 */
export type FmpCongressMemberDirectoryPort = {
  /** One page of members who are (`inOffice`) or are no longer in office. */
  getCongressMemberProfiles(input: {
    inOffice: boolean;
    page: number;
  }): Promise<FmpCongressMemberPage>;
};
