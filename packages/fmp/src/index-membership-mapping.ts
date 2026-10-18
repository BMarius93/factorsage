/**
 * The provider's index-membership and identity-history directories, normalized
 * (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * Five endpoints, each answering a question the point-in-time universe needs and nothing in the
 * product asked before:
 *
 * | Endpoint                           | Question                                                     |
 * | ---------------------------------- | ------------------------------------------------------------ |
 * | `sp500-constituent`                | Who is a member today?                                       |
 * | `historical-sp500-constituent`     | Who joined and who left, on which effective date?            |
 * | `symbol-change`                    | Which ticker did an issuer trade under before a rename?     |
 * | `delisted-companies`               | Which listings ended, on which venue? (paged, ~2015 onward)  |
 * | `historical-market-capitalization` | Was a candidate symbol plausibly an index member's security? |
 *
 * Verified live on 2026-10-17. The change log reaches back to 1957 with an effective date per row
 * and **no announcement date**: every effective date here is the date the change took effect, and
 * the product never claims to know when it was announced. Its tickers are not uniformly the ticker
 * at the event: many older rows carry the successor issuer's present-day ticker, which is why
 * reconstruction matches by identity history and resolution verifies every link against prices.
 *
 * Mappers are strict about what makes a row usable and lenient about the rest: a row without an
 * effective date or without any ticker cannot be placed in history and is dropped (and counted),
 * never repaired.
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The symbol shape every FactorSage lookup accepts. */
const SYMBOL = /^[A-Z0-9.-]{1,20}$/;

export type FmpIndexConstituentDto = {
  symbol?: unknown;
  name?: unknown;
  sector?: unknown;
  subSector?: unknown;
  headQuarter?: unknown;
  dateFirstAdded?: unknown;
  cik?: unknown;
  founded?: unknown;
};

export type FmpIndexChangeDto = {
  dateAdded?: unknown;
  addedSecurity?: unknown;
  removedTicker?: unknown;
  removedSecurity?: unknown;
  date?: unknown;
  symbol?: unknown;
  reason?: unknown;
  changeType?: unknown;
  addedTicker?: unknown;
};

export type FmpSymbolChangeDto = {
  date?: unknown;
  companyName?: unknown;
  oldSymbol?: unknown;
  newSymbol?: unknown;
};

export type FmpDelistedCompanyDto = {
  symbol?: unknown;
  companyName?: unknown;
  exchange?: unknown;
  ipoDate?: unknown;
  delistedDate?: unknown;
};

export type FmpMarketCapitalizationDto = {
  symbol?: unknown;
  date?: unknown;
  marketCap?: unknown;
};

export type MappedFmpIndexConstituent = {
  symbol: string;
  name: string;
  sector: string | null;
  subSector: string | null;
  cik: string | null;
  /** The provider's first-addition date, kept as a cross-check of the reconstruction. */
  dateFirstAdded: string | null;
};

export type MappedFmpIndexChange = {
  /** The date the change took effect. The provider carries no announcement date. */
  effectiveDate: string;
  /** The provider's own label: `addition`, `removal` or `replacement`. */
  changeType: string;
  addedTicker: string | null;
  addedName: string | null;
  removedTicker: string | null;
  removedName: string | null;
  reason: string | null;
  /**
   * The provider's long-form date (`dateAdded`, e.g. `March 04, 1957`), kept verbatim: on
   * 2026-10-17 exactly one row's long form disagreed with its effective date, and the disagreement
   * is evidence worth keeping rather than resolving silently.
   */
  providerDateText: string | null;
};

export type MappedFmpSymbolChange = {
  date: string;
  oldSymbol: string;
  newSymbol: string;
  companyName: string | null;
};

export type MappedFmpDelistedCompany = {
  symbol: string;
  companyName: string | null;
  exchange: string | null;
  ipoDate: string | null;
  delistedDate: string | null;
};

export type MappedFmpMarketCapitalization = {
  date: string;
  marketCap: number;
};

export type FmpMappedRows<T> = {
  rows: T[];
  /** Provider rows that could not be placed and were dropped. Always reported, never silent. */
  dropped: number;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

function ticker(value: unknown): string | null {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  const normalized = raw.toUpperCase();
  return SYMBOL.test(normalized) ? normalized : null;
}

function date(value: unknown): string | null {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  const day = raw.slice(0, 10);
  if (!LOCAL_DATE.test(day)) {
    return null;
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
    ? day
    : null;
}

function cik(value: unknown): string | null {
  const raw = text(value);
  return raw && /^\d{1,10}$/.test(raw) ? raw.padStart(10, "0") : null;
}

export function mapFmpIndexConstituents(
  payload: readonly FmpIndexConstituentDto[],
): FmpMappedRows<MappedFmpIndexConstituent> {
  const rows: MappedFmpIndexConstituent[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const symbol = ticker(dto.symbol);
    const name = text(dto.name);
    if (!symbol || !name) {
      dropped += 1;
      continue;
    }
    rows.push({
      symbol,
      name,
      sector: text(dto.sector),
      subSector: text(dto.subSector),
      cik: cik(dto.cik),
      dateFirstAdded: date(dto.dateFirstAdded),
    });
  }
  return { rows, dropped };
}

export function mapFmpIndexChanges(
  payload: readonly FmpIndexChangeDto[],
): FmpMappedRows<MappedFmpIndexChange> {
  const rows: MappedFmpIndexChange[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const effectiveDate = date(dto.date);
    // `addedTicker` is the provider's newer field; `symbol` carries the same ticker on additions and
    // the removed one on bare removals, so it is only a fallback for an addition.
    const changeType = (text(dto.changeType) ?? "").toLowerCase();
    const addedTicker =
      ticker(dto.addedTicker) ??
      (changeType !== "removal" ? ticker(dto.symbol) : null);
    const removedTicker = ticker(dto.removedTicker);
    if (!effectiveDate || (!addedTicker && !removedTicker)) {
      dropped += 1;
      continue;
    }
    rows.push({
      effectiveDate,
      changeType:
        changeType ||
        (addedTicker && removedTicker
          ? "replacement"
          : addedTicker
            ? "addition"
            : "removal"),
      addedTicker,
      addedName: addedTicker ? text(dto.addedSecurity) : null,
      removedTicker,
      removedName: removedTicker ? text(dto.removedSecurity) : null,
      reason: text(dto.reason),
      providerDateText: text(dto.dateAdded),
    });
  }
  return { rows, dropped };
}

export function mapFmpSymbolChanges(
  payload: readonly FmpSymbolChangeDto[],
): FmpMappedRows<MappedFmpSymbolChange> {
  const rows: MappedFmpSymbolChange[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const day = date(dto.date);
    const oldSymbol = ticker(dto.oldSymbol);
    const newSymbol = ticker(dto.newSymbol);
    // A "change" to the same ticker says nothing about identity (one such row is dated 1969).
    if (!day || !oldSymbol || !newSymbol || oldSymbol === newSymbol) {
      dropped += 1;
      continue;
    }
    rows.push({
      date: day,
      oldSymbol,
      newSymbol,
      companyName: text(dto.companyName),
    });
  }
  return { rows, dropped };
}

export function mapFmpDelistedCompanies(
  payload: readonly FmpDelistedCompanyDto[],
): FmpMappedRows<MappedFmpDelistedCompany> {
  const rows: MappedFmpDelistedCompany[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const symbol = ticker(dto.symbol);
    if (!symbol) {
      dropped += 1;
      continue;
    }
    rows.push({
      symbol,
      companyName: text(dto.companyName),
      exchange: text(dto.exchange)?.toUpperCase() ?? null,
      ipoDate: date(dto.ipoDate),
      delistedDate: date(dto.delistedDate),
    });
  }
  return { rows, dropped };
}

export function mapFmpMarketCapitalizations(
  payload: readonly FmpMarketCapitalizationDto[],
): FmpMappedRows<MappedFmpMarketCapitalization> {
  const rows: MappedFmpMarketCapitalization[] = [];
  let dropped = 0;
  for (const dto of payload) {
    const day = date(dto.date);
    const value =
      typeof dto.marketCap === "number" ? dto.marketCap : Number(dto.marketCap);
    if (!day || !Number.isFinite(value) || value < 0) {
      dropped += 1;
      continue;
    }
    rows.push({ date: day, marketCap: value });
  }
  rows.sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  return { rows, dropped };
}

/** The provider's index membership directory and the identity history around it. */
export type FmpIndexMembershipPort = {
  /** Today's constituents of `index`. */
  getIndexConstituents(
    index: FmpMembershipIndex,
  ): Promise<FmpMappedRows<MappedFmpIndexConstituent>>;
  /** Every addition and removal the provider records for `index`, newest first. */
  getIndexChanges(
    index: FmpMembershipIndex,
  ): Promise<FmpMappedRows<MappedFmpIndexChange>>;
  /** Every ticker rename the provider records, across all issuers. */
  getSymbolChanges(): Promise<FmpMappedRows<MappedFmpSymbolChange>>;
  /** One page of ended listings, newest first. */
  getDelistedCompanies(page: number): Promise<{
    providerRowCount: number;
    rows: MappedFmpDelistedCompany[];
  }>;
  /** Daily market capitalization of one symbol inside a range, ascending. */
  getHistoricalMarketCapitalization(
    symbol: string,
    range: { from: string; to: string },
  ): Promise<MappedFmpMarketCapitalization[]>;
};

/** Indices whose membership directory the provider serves. */
export const FMP_MEMBERSHIP_INDEX_PATHS = {
  SP500: {
    constituents: "sp500-constituent",
    changes: "historical-sp500-constituent",
  },
} as const;

export type FmpMembershipIndex = keyof typeof FMP_MEMBERSHIP_INDEX_PATHS;

/**
 * The provider's page size for `delisted-companies`. Its maximum on 2026-10-17; the endpoint's
 * history ends around 2015, so a whole read is under two hundred pages.
 */
export const FMP_DELISTED_COMPANIES_PAGE_SIZE = 100;

/**
 * `symbol-change` returns 100 rows unless asked for more and returned 5,517 when asked for up to
 * 100,000 on 2026-10-17. A response that fills the limit may have been truncated, and the client
 * refuses it rather than reconstructing identities from part of the history.
 */
export const FMP_SYMBOL_CHANGE_REQUEST_LIMIT = 100_000;

/** The most daily rows `historical-market-capitalization` returns in one response. */
export const FMP_MARKET_CAP_REQUEST_LIMIT = 5_000;
