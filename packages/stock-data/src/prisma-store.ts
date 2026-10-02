import { createHash } from "node:crypto";
import type {
  DailyDerivedState,
  DailyPrice,
  DateRange,
  FinancialStatementCadence,
  FinancialStatement,
  FinancialStatementDraft,
  FinancialStatementQuery,
  FinancialStatementType,
  FinancialStatement as DomainFinancialStatement,
  FundamentalMetricField,
  FundamentalMetricSnapshot,
  IntrinsicValueBlendId,
  IntrinsicValueModel,
  Security,
  SecurityProfile,
  SecurityWithLogo,
} from "@intrinsic/domain";
import {
  FUNDAMENTAL_METRIC_FIELDS,
  hasProviderFilingDate,
  selectFinancialStatements,
  statementPublicAvailabilityDate,
} from "@intrinsic/domain";
import type { MappedFmpProfile } from "@intrinsic/fmp";
import {
  FinancialPeriod as FinancialPeriodEnum,
  FinancialStatementType as FinancialStatementTypeEnum,
  PriceBasisEventKind,
  type Prisma,
  PrismaClient,
  SecurityType,
  StockDataset,
} from "@intrinsic/database";
import {
  assertOneRowPerTradingDay,
  DAILY_DERIVED_STATE_VARIANT,
} from "./derived-state.js";
import {
  PriceBasisConflictError,
  type PriceBasisEvent,
  type PriceBasisEventEvidence,
  type SecurityPriceBasisState,
} from "./price-basis.js";
import {
  DAILY_PRICE_FRESHNESS_VARIANT,
  DAILY_PRICE_VARIANT,
  DAILY_PRICE_VARIANT_FAMILY,
  WEEKLY_PRICE_VARIANT,
  type DailyPriceBounds,
  type PersistedDatasetState,
  type PersistedStockDataset,
  type PersistedSecurityCatalogEntry,
  type SecurityCatalogEntry,
  type StockDataStore,
} from "./ports.js";

/** Bind-parameter-safe page size for reading existing catalog rows during a full-universe sync. */
const SECURITY_CATALOG_READ_CHUNK = 1_000;

const INTRINSIC_MODEL_COLUMNS = {
  DCF_FCFF: "dcfFcff",
  RESIDUAL_INCOME: "residualIncome",
  DDM: "ddm",
  GRAHAM: "graham",
} as const satisfies Record<IntrinsicValueModel, string>;

/**
 * Point-in-time provenance is per intrinsic-value model, so each model has its own column. Blend
 * provenance is derived from these at read time and is never persisted.
 */
const INTRINSIC_MODEL_SOURCE_COLUMNS = {
  DCF_FCFF: "dcfFcffSourceAsOf",
  RESIDUAL_INCOME: "residualIncomeSourceAsOf",
  DDM: "ddmSourceAsOf",
  GRAHAM: "grahamSourceAsOf",
} as const satisfies Record<IntrinsicValueModel, string>;

const INTRINSIC_BLEND_COLUMNS = {
  BALANCED: "blendBalanced",
  CONSERVATIVE: "blendConservative",
  DIVIDEND: "blendDividend",
} as const satisfies Record<IntrinsicValueBlendId, string>;

type DecimalLike = { toNumber(): number };

type DailyDerivedStateRow = {
  date: Date;
  sma20d: DecimalLike | null;
  sma50d: DecimalLike | null;
  sma100d: DecimalLike | null;
  sma200d: DecimalLike | null;
  ema20d: DecimalLike | null;
  ema50d: DecimalLike | null;
  ema200d: DecimalLike | null;
  weeklySourceWeekStart: Date | null;
  sma20w: DecimalLike | null;
  sma50w: DecimalLike | null;
  sma100w: DecimalLike | null;
  sma200w: DecimalLike | null;
  ema20w: DecimalLike | null;
  ema50w: DecimalLike | null;
  ema200w: DecimalLike | null;
  rsi7d: DecimalLike | null;
  rsi14d: DecimalLike | null;
  rsi21d: DecimalLike | null;
  rvol10: DecimalLike | null;
  rvol20: DecimalLike | null;
  rvol50: DecimalLike | null;
  dcfFcff: DecimalLike | null;
  residualIncome: DecimalLike | null;
  ddm: DecimalLike | null;
  graham: DecimalLike | null;
  blendBalanced: DecimalLike | null;
  blendConservative: DecimalLike | null;
  blendDividend: DecimalLike | null;
  dcfFcffSourceAsOf: Date | null;
  residualIncomeSourceAsOf: Date | null;
  ddmSourceAsOf: Date | null;
  grahamSourceAsOf: Date | null;
  intrinsicCurrency: string | null;
} & Record<FundamentalMetricField, DecimalLike | null>;

/**
 * Fundamental Metrics share their field names with their columns, so they are mapped by iterating
 * the domain registry rather than by fifteen hand-written lines. The registry-keyed row type above
 * makes a registered metric without a Prisma column a compile error, and NULL stays absence in
 * both directions — never zero.
 */
function fundamentalMetricsFromRow(
  row: DailyDerivedStateRow,
): FundamentalMetricSnapshot {
  const values: FundamentalMetricSnapshot = {};
  for (const field of FUNDAMENTAL_METRIC_FIELDS) {
    const value = row[field];
    if (value !== null) {
      values[field] = value.toNumber();
    }
  }
  return values;
}

/**
 * A non-finite value is refused rather than written: Prisma persists `Infinity` and `NaN` in a
 * `Decimal` column as NULL, which would silently turn an upstream defect into "unavailable". The
 * formulas never produce one, so reaching here with one is a bug to surface, not a reading. A
 * finite value outside `DECIMAL(20,8)` is refused by PostgreSQL itself.
 */
function fundamentalMetricsToRow(
  row: DailyDerivedState,
): Record<FundamentalMetricField, number | null> {
  return Object.fromEntries(
    FUNDAMENTAL_METRIC_FIELDS.map((field) => {
      const value = row[field];
      if (value !== undefined && !Number.isFinite(value)) {
        throw new Error(
          `Refusing to persist a non-finite ${field} (${value}) for ${row.date}`,
        );
      }
      return [field, value ?? null];
    }),
  ) as Record<FundamentalMetricField, number | null>;
}

function dailyDerivedStateFromRow(
  securityId: string,
  row: DailyDerivedStateRow,
): DailyDerivedState {
  const intrinsicValues = Object.fromEntries(
    (
      Object.entries(INTRINSIC_MODEL_COLUMNS) as [
        IntrinsicValueModel,
        keyof DailyDerivedStateRow,
      ][]
    ).flatMap(([model, column]) => {
      const value = row[column] as DecimalLike | null;
      return value === null ? [] : [[model, value.toNumber()] as const];
    }),
  ) as Partial<Record<IntrinsicValueModel, number>>;
  const intrinsicValueBlends = Object.fromEntries(
    (
      Object.entries(INTRINSIC_BLEND_COLUMNS) as [
        IntrinsicValueBlendId,
        keyof DailyDerivedStateRow,
      ][]
    ).flatMap(([blendId, column]) => {
      const value = row[column] as DecimalLike | null;
      return value === null ? [] : [[blendId, value.toNumber()] as const];
    }),
  ) as Partial<Record<IntrinsicValueBlendId, number>>;
  // Provenance is per model: a model's instant is projected independently of the others.
  const intrinsicSourceAsOf = Object.fromEntries(
    Object.values(INTRINSIC_MODEL_SOURCE_COLUMNS).flatMap((column) => {
      const value = row[column];
      return value === null ? [] : [[column, value.toISOString()] as const];
    }),
  );

  return {
    securityId,
    date: fromDatabaseDate(row.date),
    ...(row.sma20d === null ? {} : { sma20d: row.sma20d.toNumber() }),
    ...(row.sma50d === null ? {} : { sma50d: row.sma50d.toNumber() }),
    ...(row.sma100d === null ? {} : { sma100d: row.sma100d.toNumber() }),
    ...(row.sma200d === null ? {} : { sma200d: row.sma200d.toNumber() }),
    ...(row.ema20d === null ? {} : { ema20d: row.ema20d.toNumber() }),
    ...(row.ema50d === null ? {} : { ema50d: row.ema50d.toNumber() }),
    ...(row.ema200d === null ? {} : { ema200d: row.ema200d.toNumber() }),
    ...(row.weeklySourceWeekStart === null
      ? {}
      : {
          weeklySourceWeekStart: fromDatabaseDate(row.weeklySourceWeekStart),
        }),
    ...(row.sma20w === null ? {} : { sma20w: row.sma20w.toNumber() }),
    ...(row.sma50w === null ? {} : { sma50w: row.sma50w.toNumber() }),
    ...(row.sma100w === null ? {} : { sma100w: row.sma100w.toNumber() }),
    ...(row.sma200w === null ? {} : { sma200w: row.sma200w.toNumber() }),
    ...(row.ema20w === null ? {} : { ema20w: row.ema20w.toNumber() }),
    ...(row.ema50w === null ? {} : { ema50w: row.ema50w.toNumber() }),
    ...(row.ema200w === null ? {} : { ema200w: row.ema200w.toNumber() }),
    ...(row.rsi7d === null ? {} : { rsi7d: row.rsi7d.toNumber() }),
    ...(row.rsi14d === null ? {} : { rsi14d: row.rsi14d.toNumber() }),
    ...(row.rsi21d === null ? {} : { rsi21d: row.rsi21d.toNumber() }),
    ...(row.rvol10 === null ? {} : { rvol10: row.rvol10.toNumber() }),
    ...(row.rvol20 === null ? {} : { rvol20: row.rvol20.toNumber() }),
    ...(row.rvol50 === null ? {} : { rvol50: row.rvol50.toNumber() }),
    ...fundamentalMetricsFromRow(row),
    ...(Object.keys(intrinsicValues).length === 0 ? {} : { intrinsicValues }),
    ...(Object.keys(intrinsicValueBlends).length === 0
      ? {}
      : { intrinsicValueBlends }),
    ...intrinsicSourceAsOf,
    ...(row.intrinsicCurrency === null
      ? {}
      : { intrinsicCurrency: row.intrinsicCurrency }),
  };
}

function dailyDerivedStateToRow(
  securityId: string,
  row: DailyDerivedState,
): Prisma.DailyDerivedStateCreateManyInput {
  return {
    securityId,
    date: toDatabaseDate(row.date),
    sma20d: row.sma20d ?? null,
    sma50d: row.sma50d ?? null,
    sma100d: row.sma100d ?? null,
    sma200d: row.sma200d ?? null,
    ema20d: row.ema20d ?? null,
    ema50d: row.ema50d ?? null,
    ema200d: row.ema200d ?? null,
    weeklySourceWeekStart: row.weeklySourceWeekStart
      ? toDatabaseDate(row.weeklySourceWeekStart)
      : null,
    sma20w: row.sma20w ?? null,
    sma50w: row.sma50w ?? null,
    sma100w: row.sma100w ?? null,
    sma200w: row.sma200w ?? null,
    ema20w: row.ema20w ?? null,
    ema50w: row.ema50w ?? null,
    ema200w: row.ema200w ?? null,
    rsi7d: row.rsi7d ?? null,
    rsi14d: row.rsi14d ?? null,
    rsi21d: row.rsi21d ?? null,
    rvol10: row.rvol10 ?? null,
    rvol20: row.rvol20 ?? null,
    rvol50: row.rvol50 ?? null,
    ...fundamentalMetricsToRow(row),
    dcfFcff: row.intrinsicValues?.DCF_FCFF ?? null,
    residualIncome: row.intrinsicValues?.RESIDUAL_INCOME ?? null,
    ddm: row.intrinsicValues?.DDM ?? null,
    graham: row.intrinsicValues?.GRAHAM ?? null,
    blendBalanced: row.intrinsicValueBlends?.BALANCED ?? null,
    blendConservative: row.intrinsicValueBlends?.CONSERVATIVE ?? null,
    blendDividend: row.intrinsicValueBlends?.DIVIDEND ?? null,
    dcfFcffSourceAsOf: toDatabaseInstant(row.dcfFcffSourceAsOf),
    residualIncomeSourceAsOf: toDatabaseInstant(row.residualIncomeSourceAsOf),
    ddmSourceAsOf: toDatabaseInstant(row.ddmSourceAsOf),
    grahamSourceAsOf: toDatabaseInstant(row.grahamSourceAsOf),
    intrinsicCurrency: row.intrinsicCurrency ?? null,
  };
}

function toDatabaseInstant(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

function priceBasisFromRow(row: {
  securityId: string;
  generation: number;
  verifiedAt: Date;
}): SecurityPriceBasisState {
  return {
    securityId: row.securityId,
    generation: row.generation,
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function rangeWhere(range: DateRange) {
  return {
    ...(range.from ? { gte: toDatabaseDate(range.from) } : {}),
    ...(range.to ? { lte: toDatabaseDate(range.to) } : {}),
  };
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortValue(entry));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const next = stableSortValue((value as Record<string, unknown>)[key]);
        if (next !== undefined) {
          accumulator[key] = next;
        }
        return accumulator;
      }, {});
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

function financialStatementContentHash(
  statement: FinancialStatementDraft,
): string {
  const canonical = {
    statementType: statement.statementType,
    fiscalDate: statement.fiscalDate,
    fiscalYear: statement.fiscalYear,
    period: statement.period,
    reportedCurrency: statement.reportedCurrency,
    filingDate: statement.filingDate,
    values: statement.values,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

function financialStatementIdentityKey(statement: {
  securityId: string;
  statementType: string;
  fiscalDate: string;
  fiscalYear: number;
  period: string;
}): string {
  return [
    statement.securityId,
    statement.statementType,
    statement.fiscalDate,
    statement.fiscalYear,
    statement.period,
  ].join(":");
}

/**
 * The fiscal period a statement reports on, whatever period end it gives: the unit a filing is
 * public for. Two snapshots that differ only in `fiscalDate` are two logical identities, but the
 * second is still a revision of the period the first one already made public.
 */
function financialStatementPeriodKey(statement: {
  securityId: string;
  statementType: string;
  fiscalYear: number;
  period: string;
}): string {
  return [
    statement.securityId,
    statement.statementType,
    statement.fiscalYear,
    statement.period,
  ].join(":");
}

function financialStatementRevisionKey(statement: {
  securityId: string;
  statementType: string;
  fiscalDate: string;
  fiscalYear: number;
  period: string;
  contentHash: string;
}): string {
  return `${financialStatementIdentityKey(statement)}:${statement.contentHash}`;
}

function financialStatementFromRow(row: {
  securityId: string;
  statementType: FinancialStatementTypeEnum;
  fiscalDate: Date;
  fiscalYear: number;
  period: FinancialPeriodEnum;
  reportedCurrency: string;
  filingDate: Date;
  availableFromDate: Date;
  observedAt: Date;
  contentHash: string;
  values: unknown;
}): DomainFinancialStatement {
  return {
    securityId: row.securityId,
    statementType: row.statementType,
    fiscalDate: fromDatabaseDate(row.fiscalDate),
    fiscalYear: row.fiscalYear,
    period: row.period,
    reportedCurrency: row.reportedCurrency,
    filingDate: fromDatabaseDate(row.filingDate),
    availableFromDate: fromDatabaseDate(row.availableFromDate),
    observedAt: row.observedAt.toISOString(),
    contentHash: row.contentHash,
    values: row.values as DomainFinancialStatement["values"],
  };
}

function statementPeriods(cadence?: FinancialStatementQuery["cadence"]) {
  if (cadence === "ANNUAL") {
    return [FinancialPeriodEnum.FY];
  }
  if (cadence === "QUARTERLY") {
    return [
      FinancialPeriodEnum.Q1,
      FinancialPeriodEnum.Q2,
      FinancialPeriodEnum.Q3,
      FinancialPeriodEnum.Q4,
    ];
  }
  return undefined;
}

function samePrice(
  existing: {
    open: { toNumber(): number };
    high: { toNumber(): number };
    low: { toNumber(): number };
    close: { toNumber(): number };
    volume: bigint;
    vwap: { toNumber(): number } | null;
  },
  incoming: DailyPrice,
): boolean {
  return (
    existing.open.toNumber() === incoming.open &&
    existing.high.toNumber() === incoming.high &&
    existing.low.toNumber() === incoming.low &&
    existing.close.toNumber() === incoming.close &&
    Number(existing.volume) === incoming.volume &&
    (existing.vwap?.toNumber() ?? undefined) === incoming.vwap
  );
}

function mapSecurity(row: {
  id: string;
  symbol: string;
  name: string;
  exchangeCode: string;
  exchangeName: string | null;
  currency: string;
  cik: string | null;
  isin: string | null;
  cusip: string | null;
  country: string | null;
  sector: string | null;
  industry: string | null;
  ipoDate: Date | null;
  type: SecurityType;
  isAdr: boolean;
  isActivelyTrading: boolean;
}): Security {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    exchangeCode: row.exchangeCode,
    ...(row.exchangeName ? { exchangeName: row.exchangeName } : {}),
    currency: row.currency,
    ...(row.cik ? { cik: row.cik } : {}),
    ...(row.isin ? { isin: row.isin } : {}),
    ...(row.cusip ? { cusip: row.cusip } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.industry ? { industry: row.industry } : {}),
    ...(row.ipoDate ? { ipoDate: fromDatabaseDate(row.ipoDate) } : {}),
    type: row.type,
    isAdr: row.isAdr,
    isActivelyTrading: row.isActivelyTrading,
  };
}

function datasetEnum(dataset: PersistedStockDataset): StockDataset {
  return StockDataset[dataset];
}

type PrismaTransaction = Parameters<
  Parameters<PrismaClient["$transaction"]>[0]
>[0];

/**
 * How long a bulk historical write may hold its transaction.
 *
 * Prisma's interactive-transaction default is five seconds. That is ample for a Stock Details
 * window of a year or two, and far too little for the first caller that materializes decades: a
 * thirty-year derived-state rebuild writes roughly 7,500 rows behind an advisory lock and passes
 * five seconds on ordinary hardware, at which point the transaction expires with P2028 and the
 * whole hydration fails. Backtests are that caller, so the budget is stated rather than inherited.
 * These transactions are per security per hydration, not per read.
 */
const BULK_WRITE_TRANSACTION_TIMEOUT_MS = 120_000;
/** Waiting for a connection must not be what fails a hydration on a busy pool. */
const BULK_WRITE_TRANSACTION_MAX_WAIT_MS = 30_000;

const BULK_WRITE_TRANSACTION_OPTIONS = {
  timeout: BULK_WRITE_TRANSACTION_TIMEOUT_MS,
  maxWait: BULK_WRITE_TRANSACTION_MAX_WAIT_MS,
} as const;

export class PrismaStockDataStore implements StockDataStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findSecurityByProviderSymbol(symbol: string): Promise<Security | null> {
    const row = await this.prisma.security.findUnique({
      where: { providerSymbol: symbol.trim().toUpperCase() },
    });
    return row ? mapSecurity(row) : null;
  }

  async findSecuritiesByIds(
    securityIds: readonly string[],
  ): Promise<Security[]> {
    if (securityIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.security.findMany({
      where: { id: { in: [...securityIds] } },
      orderBy: { symbol: "asc" },
    });
    return rows.map(mapSecurity);
  }

  async searchSecurities(input: {
    term: string;
    limit: number;
  }): Promise<SecurityWithLogo[]> {
    const term = input.term.trim();
    if (term === "") {
      return [];
    }

    // Symbol matching is prefix-only: an infix symbol match ("PL" in "AAPL") is noise, whereas an
    // infix name match ("micro" in "Advanced Micro Devices") is how people actually recall names.
    const rows = await this.prisma.security.findMany({
      where: {
        OR: [
          { symbol: { startsWith: term, mode: "insensitive" } },
          { name: { contains: term, mode: "insensitive" } },
        ],
      },
      // The mark comes along on the same read. A left join on an indexed primary key costs
      // nothing next to the match itself, and the alternative — a second query per keystroke —
      // would put a round trip on the search path for a decoration.
      include: { profile: { select: { logoUrl: true } } },
      orderBy: [{ symbol: "asc" }],
      take: input.limit,
    });
    return rows.map((row) => ({
      ...mapSecurity(row),
      ...(row.profile?.logoUrl ? { logoUrl: row.profile.logoUrl } : {}),
    }));
  }

  async findSecurityCatalogEntries(
    providerSymbols: readonly string[],
  ): Promise<PersistedSecurityCatalogEntry[]> {
    if (providerSymbols.length === 0) {
      return [];
    }
    const entries: PersistedSecurityCatalogEntry[] = [];
    // Chunked so a full-universe sync cannot build a single query with thousands of bind
    // parameters.
    for (
      let start = 0;
      start < providerSymbols.length;
      start += SECURITY_CATALOG_READ_CHUNK
    ) {
      const rows = await this.prisma.security.findMany({
        where: {
          providerSymbol: {
            in: [
              ...providerSymbols.slice(
                start,
                start + SECURITY_CATALOG_READ_CHUNK,
              ),
            ],
          },
        },
      });
      entries.push(
        ...rows.map((row) => ({
          providerSymbol: row.providerSymbol,
          security: mapSecurity(row),
        })),
      );
    }
    return entries;
  }

  async createSecurityCatalogEntries(
    entries: readonly SecurityCatalogEntry[],
  ): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }
    const result = await this.prisma.security.createMany({
      data: entries.map((entry) => ({
        providerSymbol: entry.providerSymbol,
        ...entry.security,
        type: SecurityType[entry.security.type],
      })),
      // A concurrent sync, or a symbol the provider lists twice, must not fail the batch.
      skipDuplicates: true,
    });
    return result.count;
  }

  async updateSecurityCatalogEntry(
    entry: SecurityCatalogEntry,
  ): Promise<Security> {
    // Only the catalog-owned fields are written. CIK, ISIN, CUSIP, IPO date and ADR status come
    // from the per-stock profile, and a bulk universe row has none of them to offer.
    const row = await this.prisma.security.update({
      where: { providerSymbol: entry.providerSymbol },
      data: {
        symbol: entry.security.symbol,
        name: entry.security.name,
        exchangeCode: entry.security.exchangeCode,
        exchangeName: entry.security.exchangeName ?? null,
        currency: entry.security.currency,
        country: entry.security.country ?? null,
        sector: entry.security.sector ?? null,
        industry: entry.security.industry ?? null,
        type: SecurityType[entry.security.type],
        isActivelyTrading: entry.security.isActivelyTrading,
      },
    });
    return mapSecurity(row);
  }

  async saveSecurityProfile(input: {
    securityId: string;
    mapped: MappedFmpProfile;
    syncedAt: string;
  }): Promise<{ security: Security; profile: SecurityProfile }> {
    const { mapped, syncedAt } = input;
    return this.prisma.$transaction(async (transaction) => {
      // `update`, never `upsert`: profile hydration refines a catalog entry that already exists
      // and must not be able to create an unknown security behind the catalog's back.
      const security = await transaction.security.update({
        where: { id: input.securityId },
        data: {
          ...mapped.security,
          ipoDate: mapped.security.ipoDate
            ? toDatabaseDate(mapped.security.ipoDate)
            : null,
          type: SecurityType[mapped.security.type],
        },
      });
      const address = mapped.profile.address;
      const profile = await transaction.securityProfile.upsert({
        where: { securityId: security.id },
        create: {
          securityId: security.id,
          description: mapped.profile.description,
          website: mapped.profile.website,
          logoUrl: mapped.profile.logoUrl,
          ceo: mapped.profile.ceo,
          employees: mapped.profile.employees,
          addressStreet: address?.street,
          addressCity: address?.city,
          addressState: address?.state,
          postalCode: address?.postalCode,
          addressCountry: address?.country,
        },
        update: {
          description: mapped.profile.description,
          website: mapped.profile.website,
          logoUrl: mapped.profile.logoUrl,
          ceo: mapped.profile.ceo,
          employees: mapped.profile.employees,
          addressStreet: address?.street,
          addressCity: address?.city,
          addressState: address?.state,
          postalCode: address?.postalCode,
          addressCountry: address?.country,
        },
      });
      await transaction.stockDatasetState.upsert({
        where: {
          securityId_dataset_variant: {
            securityId: security.id,
            dataset: StockDataset.SECURITY_PROFILE,
            variant: "",
          },
        },
        create: {
          securityId: security.id,
          dataset: StockDataset.SECURITY_PROFILE,
          variant: "",
          lastSuccessfulSyncAt: new Date(syncedAt),
        },
        update: { lastSuccessfulSyncAt: new Date(syncedAt) },
      });
      return {
        security: mapSecurity(security),
        profile: {
          securityId: security.id,
          ...(profile.description ? { description: profile.description } : {}),
          ...(profile.website ? { website: profile.website } : {}),
          ...(profile.logoUrl ? { logoUrl: profile.logoUrl } : {}),
          ...(profile.ceo ? { ceo: profile.ceo } : {}),
          ...(profile.employees === null
            ? {}
            : { employees: profile.employees }),
          address: {
            ...(profile.addressStreet ? { street: profile.addressStreet } : {}),
            ...(profile.addressCity ? { city: profile.addressCity } : {}),
            ...(profile.addressState ? { state: profile.addressState } : {}),
            ...(profile.postalCode ? { postalCode: profile.postalCode } : {}),
            ...(profile.addressCountry
              ? { country: profile.addressCountry }
              : {}),
          },
        },
      };
    });
  }

  async getProfile(securityId: string): Promise<SecurityProfile | null> {
    const row = await this.prisma.securityProfile.findUnique({
      where: { securityId },
    });
    if (!row) {
      return null;
    }
    return {
      securityId,
      ...(row.description ? { description: row.description } : {}),
      ...(row.website ? { website: row.website } : {}),
      ...(row.logoUrl ? { logoUrl: row.logoUrl } : {}),
      ...(row.ceo ? { ceo: row.ceo } : {}),
      ...(row.employees === null ? {} : { employees: row.employees }),
      address: {
        ...(row.addressStreet ? { street: row.addressStreet } : {}),
        ...(row.addressCity ? { city: row.addressCity } : {}),
        ...(row.addressState ? { state: row.addressState } : {}),
        ...(row.postalCode ? { postalCode: row.postalCode } : {}),
        ...(row.addressCountry ? { country: row.addressCountry } : {}),
      },
    };
  }

  async getDatasetState(
    securityId: string,
    dataset: PersistedStockDataset,
    variant = "",
  ): Promise<PersistedDatasetState | null> {
    const row = await this.prisma.stockDatasetState.findUnique({
      where: {
        securityId_dataset_variant: {
          securityId,
          dataset: datasetEnum(dataset),
          variant,
        },
      },
    });
    return row
      ? {
          securityId,
          dataset,
          variant,
          ...(row.earliestDate
            ? { earliestDate: fromDatabaseDate(row.earliestDate) }
            : {}),
          ...(row.latestDate
            ? { latestDate: fromDatabaseDate(row.latestDate) }
            : {}),
          ...(row.lastSuccessfulSyncAt
            ? { lastSyncedAt: row.lastSuccessfulSyncAt.toISOString() }
            : {}),
        }
      : null;
  }

  async getDatasetCoverage(
    securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    range: Required<DateRange>,
  ): Promise<Required<DateRange>[]> {
    const rows = await this.prisma.stockDatasetCoverage.findMany({
      where: {
        securityId,
        dataset: datasetEnum(dataset),
        variant,
        fromDate: { lte: toDatabaseDate(range.to) },
        toDate: { gte: toDatabaseDate(range.from) },
      },
      orderBy: { fromDate: "asc" },
    });
    return rows.map((row) => ({
      from: fromDatabaseDate(row.fromDate),
      to: fromDatabaseDate(row.toDate),
    }));
  }

  async getLatestCoverageSyncContainingDate(
    securityId: string,
    dataset: PersistedStockDataset,
    variant: string,
    date: string,
  ): Promise<string | null> {
    const target = toDatabaseDate(date);
    if (dataset === "DAILY_PRICE" && variant === DAILY_PRICE_VARIANT) {
      const freshness = await this.prisma.stockDatasetState.findUnique({
        where: {
          securityId_dataset_variant: {
            securityId,
            dataset: StockDataset.DAILY_PRICE,
            variant: DAILY_PRICE_FRESHNESS_VARIANT,
          },
        },
      });
      return freshness?.latestDate && freshness.latestDate >= target
        ? (freshness.lastSuccessfulSyncAt?.toISOString() ?? null)
        : null;
    }
    const row = await this.prisma.stockDatasetCoverage.findFirst({
      where: {
        securityId,
        dataset: datasetEnum(dataset),
        variant,
        fromDate: { lte: target },
        toDate: { gte: target },
      },
      orderBy: { lastSuccessfulSyncAt: "desc" },
    });
    return row?.lastSuccessfulSyncAt.toISOString() ?? null;
  }

  async getDailyPrices(
    securityId: string,
    range: DateRange,
  ): Promise<DailyPrice[]> {
    const rows = await this.prisma.dailyPrice.findMany({
      where: { securityId, date: rangeWhere(range) },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => ({
      securityId,
      date: fromDatabaseDate(row.date),
      open: row.open.toNumber(),
      high: row.high.toNumber(),
      low: row.low.toNumber(),
      close: row.close.toNumber(),
      volume: Number(row.volume),
      ...(row.vwap === null ? {} : { vwap: row.vwap.toNumber() }),
    }));
  }

  /**
   * One aggregate over the persisted price rows in a range, so a caller can tell whether a security
   * has usable history there without reading the history.
   *
   * PostgreSQL, not the Redis projection, deliberately: this answers a question about durable
   * coverage, and the answer must not depend on what a disposable cache currently holds.
   */
  async getDailyPriceBounds(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPriceBounds | null> {
    const aggregate = await this.prisma.dailyPrice.aggregate({
      where: { securityId, date: rangeWhere(range) },
      _min: { date: true },
      _max: { date: true },
      _count: { date: true },
    });
    const firstDate = aggregate._min.date;
    const lastDate = aggregate._max.date;
    if (firstDate === null || lastDate === null) {
      return null;
    }
    return {
      firstDate: fromDatabaseDate(firstDate),
      lastDate: fromDatabaseDate(lastDate),
      tradingDays: aggregate._count.date,
    };
  }

  async getEarliestDailyPriceDate(securityId: string): Promise<string | null> {
    const row = await this.prisma.dailyPrice.findFirst({
      where: { securityId },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    return row ? fromDatabaseDate(row.date) : null;
  }

  async saveDailyPriceSync(
    input: Parameters<StockDataStore["saveDailyPriceSync"]>[0],
  ): Promise<{ earliestChangedDate?: string }> {
    if (input.successfulCoverage.length === 0) {
      return {};
    }
    const existingRows =
      input.prices.length === 0
        ? []
        : await this.prisma.dailyPrice.findMany({
            where: {
              securityId: input.securityId,
              date: {
                in: input.prices.map((price) => toDatabaseDate(price.date)),
              },
            },
          });
    const existingByDate = new Map(
      existingRows.map((row) => [fromDatabaseDate(row.date), row]),
    );
    const earliestChangedDate = input.prices
      .filter((price) => {
        const existing = existingByDate.get(price.date);
        return !existing || !samePrice(existing, price);
      })
      .map((price) => price.date)
      .sort()[0];
    await this.prisma.$transaction(async (transaction) => {
      await this.lockStockWrite(transaction, input.securityId);
      const affectedDates = [
        ...new Set(input.prices.map((price) => toDatabaseDate(price.date))),
      ];
      if (affectedDates.length > 0) {
        await transaction.dailyPrice.deleteMany({
          where: {
            securityId: input.securityId,
            date: { in: affectedDates },
          },
        });
        await transaction.dailyPrice.createMany({
          data: input.prices.map((price) => ({
            securityId: input.securityId,
            date: toDatabaseDate(price.date),
            open: price.open,
            high: price.high,
            low: price.low,
            close: price.close,
            volume: BigInt(price.volume),
            vwap: price.vwap,
          })),
        });
      }
      for (const coverage of input.successfulCoverage) {
        await this.advanceState(transaction, {
          securityId: input.securityId,
          dataset: "DAILY_PRICE",
          variant: DAILY_PRICE_VARIANT,
          from: coverage.from,
          to: coverage.to,
          syncedAt: input.syncedAt,
        });
      }
      // One generation of price coverage per stock. Intervals recorded under a superseded
      // `PRICE_DATASET_VERSION` described what the loader no longer trusts; once the current
      // variant is established they are removed rather than left to read as resident history.
      // Same predicate as `isSupersededDailyPriceVariant`, expressed for the database: earlier
      // revisions of this dataset family only, never an unrelated variant of the same dataset.
      const superseded = {
        securityId: input.securityId,
        dataset: StockDataset.DAILY_PRICE,
        variant: {
          startsWith: DAILY_PRICE_VARIANT_FAMILY,
          notIn: [DAILY_PRICE_VARIANT, DAILY_PRICE_FRESHNESS_VARIANT],
        },
      };
      await transaction.stockDatasetCoverage.deleteMany({ where: superseded });
      await transaction.stockDatasetState.deleteMany({ where: superseded });
      if (input.freshThrough && input.freshThrough >= input.tailDate) {
        await this.advanceFreshnessState(transaction, {
          securityId: input.securityId,
          tailDate: input.tailDate,
          syncedAt: input.syncedAt,
        });
      }
      input.assertOwned?.();
    }, BULK_WRITE_TRANSACTION_OPTIONS);
    return earliestChangedDate ? { earliestChangedDate } : {};
  }

  async getDailyDerivedState(
    securityId: string,
    range: DateRange,
  ): Promise<DailyDerivedState[]> {
    const rows = await this.prisma.dailyDerivedState.findMany({
      where: { securityId, date: rangeWhere(range) },
      orderBy: { date: "asc" },
    });
    return rows.map((row) => dailyDerivedStateFromRow(securityId, row));
  }

  async saveDailyDerivedState(
    input: Parameters<StockDataStore["saveDailyDerivedState"]>[0],
  ): Promise<void> {
    assertOneRowPerTradingDay(input.rows);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockStockWrite(transaction, input.securityId);

      const affectedDates = input.rows.map((row) => toDatabaseDate(row.date));
      if (affectedDates.length > 0) {
        // One current methodology per (securityId, date): replace, never append a version.
        await transaction.dailyDerivedState.deleteMany({
          where: { securityId: input.securityId, date: { in: affectedDates } },
        });
        await transaction.dailyDerivedState.createMany({
          data: input.rows.map((row) =>
            dailyDerivedStateToRow(input.securityId, row),
          ),
        });
      }
      await this.advanceState(transaction, {
        securityId: input.securityId,
        dataset: "DAILY_DERIVED_STATE",
        variant: DAILY_DERIVED_STATE_VARIANT,
        from: input.successfulCoverage.from,
        to: input.successfulCoverage.to,
        syncedAt: input.syncedAt,
      });

      if (input.weeklyPrices.length > 0) {
        const affectedWeeklyStarts = [
          ...new Set(
            input.weeklyPrices.map((weekly) =>
              toDatabaseDate(weekly.weekStartDate),
            ),
          ),
        ];
        await transaction.weeklyPrice.deleteMany({
          where: {
            securityId: input.securityId,
            weekStartDate: { in: affectedWeeklyStarts },
          },
        });
        await transaction.weeklyPrice.createMany({
          data: input.weeklyPrices.map((weekly) => ({
            ...weekly,
            securityId: input.securityId,
            weekStartDate: toDatabaseDate(weekly.weekStartDate),
            weekEndDate: toDatabaseDate(weekly.weekEndDate),
            eligibleDate: toDatabaseDate(weekly.eligibleDate),
            volume: BigInt(weekly.volume),
          })),
        });
      }

      await this.advanceState(transaction, {
        securityId: input.securityId,
        dataset: "WEEKLY_PRICE",
        variant: WEEKLY_PRICE_VARIANT,
        from:
          input.weeklyPrices[0]?.weekStartDate ?? input.successfulCoverage.from,
        to:
          input.weeklyPrices.at(-1)?.weekEndDate ?? input.successfulCoverage.to,
        syncedAt: input.syncedAt,
      });
      input.assertOwned?.();
    }, BULK_WRITE_TRANSACTION_OPTIONS);
  }

  async getPriceBasis(
    securityId: string,
  ): Promise<SecurityPriceBasisState | null> {
    const row = await this.prisma.securityPriceBasis.findUnique({
      where: { securityId },
    });
    return row ? priceBasisFromRow(row) : null;
  }

  async getPriceBasisEvents(securityId: string): Promise<PriceBasisEvent[]> {
    const rows = await this.prisma.priceBasisEvent.findMany({
      where: { securityId },
      orderBy: [{ generation: "asc" }, { detectedAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      securityId: row.securityId,
      generation: row.generation,
      kind: row.kind,
      ...(row.effectiveDate
        ? { effectiveDate: fromDatabaseDate(row.effectiveDate) }
        : {}),
      ...(row.effectiveFrom
        ? { effectiveFrom: fromDatabaseDate(row.effectiveFrom) }
        : {}),
      ...(row.effectiveTo
        ? { effectiveTo: fromDatabaseDate(row.effectiveTo) }
        : {}),
      ...(row.priceRatio === null
        ? {}
        : { priceRatio: row.priceRatio.toNumber() }),
      detectedAt: row.detectedAt.toISOString(),
      evidence: row.evidence as unknown as PriceBasisEventEvidence,
    }));
  }

  async createPriceBasis(input: {
    securityId: string;
    verifiedAt: string;
  }): Promise<SecurityPriceBasisState> {
    const row = await this.prisma.securityPriceBasis.upsert({
      where: { securityId: input.securityId },
      create: {
        securityId: input.securityId,
        generation: 0,
        verifiedAt: new Date(input.verifiedAt),
      },
      // An existing row is never rewritten: `verifiedAt` and the generation only move forward.
      update: {},
    });
    return priceBasisFromRow(row);
  }

  async replaceDailyPriceHistory(
    input: Parameters<StockDataStore["replaceDailyPriceHistory"]>[0],
  ): Promise<SecurityPriceBasisState> {
    assertOneRowPerTradingDay(input.derivedRows);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockStockWrite(transaction, input.securityId);
      const current = await transaction.securityPriceBasis.findUnique({
        where: { securityId: input.securityId },
      });
      if ((current?.generation ?? 0) !== input.expectedGeneration) {
        throw new PriceBasisConflictError(
          input.securityId,
          input.expectedGeneration,
          current?.generation ?? 0,
        );
      }
      const generation = (current?.generation ?? 0) + 1;

      await transaction.dailyPrice.deleteMany({
        where: { securityId: input.securityId },
      });
      await transaction.dailyPrice.createMany({
        data: input.prices.map((price) => ({
          securityId: input.securityId,
          date: toDatabaseDate(price.date),
          open: price.open,
          high: price.high,
          low: price.low,
          close: price.close,
          volume: BigInt(price.volume),
          vwap: price.vwap,
        })),
      });
      await this.advanceState(transaction, {
        securityId: input.securityId,
        dataset: "DAILY_PRICE",
        variant: DAILY_PRICE_VARIANT,
        from: input.priceCoverage.from,
        to: input.priceCoverage.to,
        syncedAt: input.syncedAt,
      });
      if (input.freshThrough && input.freshThrough >= input.tailDate) {
        await this.advanceFreshnessState(transaction, {
          securityId: input.securityId,
          tailDate: input.tailDate,
          syncedAt: input.syncedAt,
        });
      }

      // Every derived row and every weekly row was computed from prices that no longer exist, so
      // all of them and their coverage go, and exactly the rebuilt range is re-established.
      const derived = {
        securityId: input.securityId,
        dataset: StockDataset.DAILY_DERIVED_STATE,
        variant: DAILY_DERIVED_STATE_VARIANT,
      };
      await transaction.dailyDerivedState.deleteMany({
        where: { securityId: input.securityId },
      });
      await transaction.stockDatasetCoverage.deleteMany({ where: derived });
      await transaction.stockDatasetState.deleteMany({ where: derived });
      await transaction.dailyDerivedState.createMany({
        data: input.derivedRows.map((row) =>
          dailyDerivedStateToRow(input.securityId, row),
        ),
      });
      await this.advanceState(transaction, {
        securityId: input.securityId,
        dataset: "DAILY_DERIVED_STATE",
        variant: DAILY_DERIVED_STATE_VARIANT,
        from: input.derivedCoverage.from,
        to: input.derivedCoverage.to,
        syncedAt: input.syncedAt,
      });

      const weekly = {
        securityId: input.securityId,
        dataset: StockDataset.WEEKLY_PRICE,
        variant: WEEKLY_PRICE_VARIANT,
      };
      await transaction.weeklyPrice.deleteMany({
        where: { securityId: input.securityId },
      });
      await transaction.stockDatasetCoverage.deleteMany({ where: weekly });
      await transaction.stockDatasetState.deleteMany({ where: weekly });
      if (input.weeklyPrices.length > 0) {
        await transaction.weeklyPrice.createMany({
          data: input.weeklyPrices.map((bar) => ({
            ...bar,
            securityId: input.securityId,
            weekStartDate: toDatabaseDate(bar.weekStartDate),
            weekEndDate: toDatabaseDate(bar.weekEndDate),
            eligibleDate: toDatabaseDate(bar.eligibleDate),
            volume: BigInt(bar.volume),
          })),
        });
        await this.advanceState(transaction, {
          securityId: input.securityId,
          dataset: "WEEKLY_PRICE",
          variant: WEEKLY_PRICE_VARIANT,
          from: input.weeklyPrices[0]!.weekStartDate,
          to: input.weeklyPrices.at(-1)!.weekEndDate,
          syncedAt: input.syncedAt,
        });
      }

      if (input.events.length > 0) {
        await transaction.priceBasisEvent.createMany({
          data: input.events.map((event) => ({
            securityId: input.securityId,
            // The replacement that recorded it, whatever the caller assumed.
            generation,
            kind: PriceBasisEventKind[event.kind],
            effectiveDate: event.effectiveDate
              ? toDatabaseDate(event.effectiveDate)
              : null,
            effectiveFrom: event.effectiveFrom
              ? toDatabaseDate(event.effectiveFrom)
              : null,
            effectiveTo: event.effectiveTo
              ? toDatabaseDate(event.effectiveTo)
              : null,
            priceRatio: event.priceRatio ?? null,
            detectedAt: new Date(event.detectedAt),
            evidence: event.evidence as unknown as Prisma.InputJsonValue,
          })),
        });
      }
      const basis = await transaction.securityPriceBasis.upsert({
        where: { securityId: input.securityId },
        create: {
          securityId: input.securityId,
          generation,
          verifiedAt: new Date(input.verifiedAt),
        },
        update: { generation },
      });
      input.assertOwned?.();
      return priceBasisFromRow(basis);
    }, BULK_WRITE_TRANSACTION_OPTIONS);
  }

  async getFinancialStatements(
    securityId: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    const rows = await this.prisma.financialStatement.findMany({
      where: {
        securityId,
        ...(query.statementTypes
          ? {
              statementType: {
                in: query.statementTypes.map(
                  (statementType) => FinancialStatementTypeEnum[statementType],
                ),
              },
            }
          : {}),
        ...(statementPeriods(query.cadence)
          ? { period: { in: statementPeriods(query.cadence) } }
          : {}),
        ...(query.from
          ? { fiscalDate: { gte: toDatabaseDate(query.from) } }
          : {}),
        ...(query.to ? { fiscalDate: { lte: toDatabaseDate(query.to) } } : {}),
        ...(query.asOf
          ? { availableFromDate: { lte: toDatabaseDate(query.asOf) } }
          : {}),
      },
      orderBy: [
        { fiscalDate: "asc" },
        { statementType: "asc" },
        { period: "asc" },
        { availableFromDate: "asc" },
        { observedAt: "asc" },
      ],
    });
    return selectFinancialStatements(
      rows.map(financialStatementFromRow),
      query,
    );
  }

  async saveFinancialStatements(input: {
    securityId: string;
    statements: readonly FinancialStatementDraft[];
    syncedAt: string;
  }): Promise<{ insertedRevisionCount: number; unchangedCount: number }> {
    if (input.statements.length === 0) {
      return { insertedRevisionCount: 0, unchangedCount: 0 };
    }
    const observedAt = new Date(input.syncedAt);
    const observedAtCalendarDate = toDatabaseDate(fromDatabaseDate(observedAt));
    return this.prisma.$transaction(async (transaction) => {
      await this.lockStockWrite(transaction, input.securityId);
      const existingRows = await transaction.financialStatement.findMany({
        where: { securityId: input.securityId },
      });
      const existingByRevision = new Set(
        existingRows.map((row) =>
          financialStatementRevisionKey({
            securityId: row.securityId,
            statementType: row.statementType,
            fiscalDate: fromDatabaseDate(row.fiscalDate),
            fiscalYear: row.fiscalYear,
            period: row.period,
            contentHash: row.contentHash,
          }),
        ),
      );
      const latestKnownFilingDateByIdentity = new Map<string, Date>();
      // When the latest filing an earlier sync stored for each fiscal period became public,
      // whatever period end it came with — a period-end placeholder counting at its statutory
      // deadline, exactly as it was dated (AUD-03). Only earlier syncs count: snapshots arriving
      // together are observed together, so their order in the provider response never decides
      // which one was public first.
      const storedPublicDateByPeriod = new Map<string, string>();
      for (const row of existingRows) {
        const identity = financialStatementIdentityKey({
          securityId: row.securityId,
          statementType: row.statementType,
          fiscalDate: fromDatabaseDate(row.fiscalDate),
          fiscalYear: row.fiscalYear,
          period: row.period,
        });
        const known = latestKnownFilingDateByIdentity.get(identity);
        if (!known || row.filingDate.valueOf() > known.valueOf()) {
          latestKnownFilingDateByIdentity.set(identity, row.filingDate);
        }
        const period = financialStatementPeriodKey(row);
        const publicDate = statementPublicAvailabilityDate({
          fiscalDate: fromDatabaseDate(row.fiscalDate),
          filingDate: fromDatabaseDate(row.filingDate),
          period: row.period,
        });
        const stored = storedPublicDateByPeriod.get(period);
        if (!stored || publicDate > stored) {
          storedPublicDateByPeriod.set(period, publicDate);
        }
      }
      const rowsToInsert: Array<{
        securityId: string;
        statementType: FinancialStatementTypeEnum;
        fiscalDate: Date;
        fiscalYear: number;
        period: FinancialPeriodEnum;
        reportedCurrency: string;
        filingDate: Date;
        availableFromDate: Date;
        providerAcceptedDate: string | null;
        contentHash: string;
        observedAt: Date;
        values: Prisma.InputJsonValue;
      }> = [];
      let insertedRevisionCount = 0;
      let unchangedCount = 0;
      const plannedRevisions = new Set<string>();

      // Oldest filing first. A row is judged against the filings already known for its identity,
      // including rows this sync planned before it, so a response listing an amendment before the
      // original would otherwise make the original look like a correction "first observed now" and
      // erase it from every session between the two filings. Ascending filing date makes the
      // outcome independent of the provider's order; the sort is stable, so rows sharing a filing
      // date keep the order the provider gave them, exactly as before.
      const byFilingDate = [...input.statements].sort((left, right) =>
        left.filingDate.localeCompare(right.filingDate),
      );
      for (const statement of byFilingDate) {
        if (statement.securityId !== input.securityId) {
          throw new Error("Financial statement securityId mismatch");
        }
        const contentHash = financialStatementContentHash(statement);
        const revisionKey = financialStatementRevisionKey({
          securityId: statement.securityId,
          statementType: statement.statementType,
          fiscalDate: statement.fiscalDate,
          fiscalYear: statement.fiscalYear,
          period: statement.period,
          contentHash,
        });
        if (
          existingByRevision.has(revisionKey) ||
          plannedRevisions.has(revisionKey)
        ) {
          unchangedCount += 1;
          continue;
        }
        plannedRevisions.add(revisionKey);

        const filingDate = toDatabaseDate(statement.filingDate);
        const identity = financialStatementIdentityKey({
          securityId: statement.securityId,
          statementType: statement.statementType,
          fiscalDate: statement.fiscalDate,
          fiscalYear: statement.fiscalYear,
          period: statement.period,
        });
        const latestKnownFilingDate =
          latestKnownFilingDateByIdentity.get(identity);
        // The one point-in-time rule, owned by the domain: a real filing date plus a day, or the
        // statutory deadline when the provider gave the period end instead of a filing date
        // (AUD-03). A restatement that carries no newer filing date cannot be claimed to have been
        // public before it was observed.
        const publicDate = statementPublicAvailabilityDate({
          fiscalDate: statement.fiscalDate,
          filingDate: statement.filingDate,
          period: statement.period,
        });
        const storedPeriodPublicDate = storedPublicDateByPeriod.get(
          financialStatementPeriodKey(statement),
        );
        // A snapshot is public from its own filing only when that filing is newer than everything
        // already known for its identity and, for a fiscal period an earlier sync already stored,
        // is a real filing that became public after every stored one. A moved period end (a new
        // `fiscalDate` for a stored fiscal period) is otherwise a revision first observed now: a
        // period-end placeholder moves with the period end and proves no newer filing, and a new
        // identity is never public since its period's original filing.
        const canUseInitialAvailability =
          (!latestKnownFilingDate ||
            filingDate.valueOf() > latestKnownFilingDate.valueOf()) &&
          (!storedPeriodPublicDate ||
            (hasProviderFilingDate(statement) &&
              publicDate > storedPeriodPublicDate));
        const publicFrom = toDatabaseDate(publicDate);
        const availableFromDate = canUseInitialAvailability
          ? publicFrom
          : new Date(
              Math.max(publicFrom.valueOf(), observedAtCalendarDate.valueOf()),
            );
        rowsToInsert.push({
          securityId: statement.securityId,
          statementType: FinancialStatementTypeEnum[statement.statementType],
          fiscalDate: toDatabaseDate(statement.fiscalDate),
          fiscalYear: statement.fiscalYear,
          period: FinancialPeriodEnum[statement.period],
          reportedCurrency: statement.reportedCurrency,
          filingDate,
          availableFromDate,
          providerAcceptedDate: statement.providerAcceptedDate ?? null,
          contentHash,
          observedAt,
          values: statement.values as Prisma.InputJsonValue,
        });
        const knownFilingDate = latestKnownFilingDateByIdentity.get(identity);
        if (
          !knownFilingDate ||
          filingDate.valueOf() > knownFilingDate.valueOf()
        ) {
          latestKnownFilingDateByIdentity.set(identity, filingDate);
        }
        insertedRevisionCount += 1;
      }

      if (rowsToInsert.length > 0) {
        await transaction.financialStatement.createMany({
          data: rowsToInsert,
        });
      }

      return { insertedRevisionCount, unchangedCount };
    }, BULK_WRITE_TRANSACTION_OPTIONS);
  }

  async getFinancialStatementRevisions(input: {
    securityId: string;
    statementType?: FinancialStatementType;
    cadence?: FinancialStatementCadence;
    from?: string;
    to?: string;
  }): Promise<FinancialStatement[]> {
    const rows = await this.prisma.financialStatement.findMany({
      where: {
        securityId: input.securityId,
        ...(input.statementType
          ? {
              statementType: FinancialStatementTypeEnum[input.statementType],
            }
          : {}),
        ...(statementPeriods(input.cadence)
          ? { period: { in: statementPeriods(input.cadence) } }
          : {}),
        // One `fiscalDate` condition carrying both bounds. Two spread conditions on the same key
        // keep only the last, which silently dropped `from` whenever `to` was also given.
        ...(input.from || input.to
          ? { fiscalDate: rangeWhere({ from: input.from, to: input.to }) }
          : {}),
      },
      orderBy: [
        { fiscalDate: "asc" },
        { statementType: "asc" },
        { period: "asc" },
        { availableFromDate: "asc" },
        { observedAt: "asc" },
      ],
    });
    return rows.map(financialStatementFromRow);
  }

  async upsertDatasetState(input: {
    securityId: string;
    dataset: PersistedStockDataset;
    variant: string;
    syncedAt: string;
    earliestDate?: string;
    latestDate?: string;
  }): Promise<void> {
    const dataset = datasetEnum(input.dataset);
    const existing = await this.prisma.stockDatasetState.findUnique({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset,
          variant: input.variant,
        },
      },
    });
    const lastSuccessfulSyncAt = existing?.lastSuccessfulSyncAt
      ? new Date(
          Math.max(
            existing.lastSuccessfulSyncAt.valueOf(),
            new Date(input.syncedAt).valueOf(),
          ),
        )
      : new Date(input.syncedAt);
    const earliestDate = input.earliestDate
      ? existing?.earliestDate
        ? new Date(
            Math.min(
              existing.earliestDate.valueOf(),
              toDatabaseDate(input.earliestDate).valueOf(),
            ),
          )
        : toDatabaseDate(input.earliestDate)
      : (existing?.earliestDate ?? null);
    const latestDate = input.latestDate
      ? existing?.latestDate
        ? new Date(
            Math.max(
              existing.latestDate.valueOf(),
              toDatabaseDate(input.latestDate).valueOf(),
            ),
          )
        : toDatabaseDate(input.latestDate)
      : (existing?.latestDate ?? null);

    await this.prisma.stockDatasetState.upsert({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset,
          variant: input.variant,
        },
      },
      create: {
        securityId: input.securityId,
        dataset,
        variant: input.variant,
        lastSuccessfulSyncAt,
        ...(earliestDate ? { earliestDate } : {}),
        ...(latestDate ? { latestDate } : {}),
      },
      update: {
        lastSuccessfulSyncAt,
        ...(earliestDate ? { earliestDate } : {}),
        ...(latestDate ? { latestDate } : {}),
      },
    });
  }

  private async advanceState(
    transaction: PrismaTransaction,
    input: {
      securityId: string;
      dataset: PersistedStockDataset;
      variant: string;
      from: string;
      to: string;
      syncedAt: string;
    },
  ): Promise<void> {
    const dataset = datasetEnum(input.dataset);
    const existingCoverage = await transaction.stockDatasetCoverage.findMany({
      where: {
        securityId: input.securityId,
        dataset,
        variant: input.variant,
      },
      orderBy: { fromDate: "asc" },
    });
    const intervals = [
      ...existingCoverage.map((coverage) => ({
        fromDate: coverage.fromDate,
        toDate: coverage.toDate,
        lastSuccessfulSyncAt: coverage.lastSuccessfulSyncAt,
      })),
      {
        fromDate: toDatabaseDate(input.from),
        toDate: toDatabaseDate(input.to),
        lastSuccessfulSyncAt: new Date(input.syncedAt),
      },
    ].sort((left, right) => left.fromDate.valueOf() - right.fromDate.valueOf());
    const compacted: typeof intervals = [];
    for (const interval of intervals) {
      const previous = compacted.at(-1);
      if (
        previous &&
        interval.fromDate.valueOf() <=
          previous.toDate.valueOf() + 24 * 60 * 60 * 1_000
      ) {
        previous.toDate = new Date(
          Math.max(previous.toDate.valueOf(), interval.toDate.valueOf()),
        );
        previous.lastSuccessfulSyncAt = new Date(
          Math.max(
            previous.lastSuccessfulSyncAt.valueOf(),
            interval.lastSuccessfulSyncAt.valueOf(),
          ),
        );
      } else {
        compacted.push({ ...interval });
      }
    }
    await transaction.stockDatasetCoverage.deleteMany({
      where: {
        securityId: input.securityId,
        dataset,
        variant: input.variant,
      },
    });
    await transaction.stockDatasetCoverage.createMany({
      data: compacted.map((coverage) => ({
        securityId: input.securityId,
        dataset,
        variant: input.variant,
        ...coverage,
      })),
    });
    const existing = await transaction.stockDatasetState.findUnique({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset,
          variant: input.variant,
        },
      },
    });
    const earliestDate = existing?.earliestDate
      ? new Date(
          Math.min(
            existing.earliestDate.valueOf(),
            toDatabaseDate(input.from).valueOf(),
          ),
        )
      : toDatabaseDate(input.from);
    const latestDate = existing?.latestDate
      ? new Date(
          Math.max(
            existing.latestDate.valueOf(),
            toDatabaseDate(input.to).valueOf(),
          ),
        )
      : toDatabaseDate(input.to);
    const lastSuccessfulSyncAt = existing?.lastSuccessfulSyncAt
      ? new Date(
          Math.max(
            existing.lastSuccessfulSyncAt.valueOf(),
            new Date(input.syncedAt).valueOf(),
          ),
        )
      : new Date(input.syncedAt);
    await transaction.stockDatasetState.upsert({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset,
          variant: input.variant,
        },
      },
      create: {
        securityId: input.securityId,
        dataset,
        variant: input.variant,
        earliestDate,
        latestDate,
        lastSuccessfulSyncAt,
      },
      update: {
        earliestDate,
        latestDate,
        lastSuccessfulSyncAt,
      },
    });
  }

  private async advanceFreshnessState(
    transaction: PrismaTransaction,
    input: { securityId: string; tailDate: string; syncedAt: string },
  ): Promise<void> {
    const tailDate = toDatabaseDate(input.tailDate);
    const existing = await transaction.stockDatasetState.findUnique({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset: StockDataset.DAILY_PRICE,
          variant: DAILY_PRICE_FRESHNESS_VARIANT,
        },
      },
    });
    if (existing?.latestDate && existing.latestDate > tailDate) {
      return;
    }
    const lastSuccessfulSyncAt = existing?.lastSuccessfulSyncAt
      ? new Date(
          Math.max(
            existing.lastSuccessfulSyncAt.valueOf(),
            new Date(input.syncedAt).valueOf(),
          ),
        )
      : new Date(input.syncedAt);
    await transaction.stockDatasetState.upsert({
      where: {
        securityId_dataset_variant: {
          securityId: input.securityId,
          dataset: StockDataset.DAILY_PRICE,
          variant: DAILY_PRICE_FRESHNESS_VARIANT,
        },
      },
      create: {
        securityId: input.securityId,
        dataset: StockDataset.DAILY_PRICE,
        variant: DAILY_PRICE_FRESHNESS_VARIANT,
        earliestDate: tailDate,
        latestDate: tailDate,
        lastSuccessfulSyncAt,
      },
      update: {
        latestDate: tailDate,
        lastSuccessfulSyncAt,
      },
    });
  }

  private async lockStockWrite(
    transaction: PrismaTransaction,
    securityId: string,
  ): Promise<void> {
    // The advisory lock is scoped to the active Prisma transaction and must be
    // acquired once at the outer boundary. Nested state helpers operate on the
    // same transaction client and must not re-enter the Prisma transaction layer.
    const lockKey = `stock-data-write:${securityId}`;
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }
}
