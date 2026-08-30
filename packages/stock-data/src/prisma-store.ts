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
  IntrinsicValueBlendId,
  IntrinsicValueModel,
  Security,
  SecurityProfile,
} from "@intrinsic/domain";
import { selectFinancialStatements } from "@intrinsic/domain";
import type { MappedFmpProfile } from "@intrinsic/fmp";
import {
  FinancialPeriod as FinancialPeriodEnum,
  FinancialStatementType as FinancialStatementTypeEnum,
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
  DAILY_PRICE_FRESHNESS_VARIANT,
  DAILY_PRICE_VARIANT,
  WEEKLY_PRICE_VARIANT,
  type PersistedDatasetState,
  type PersistedStockDataset,
  type StockDataStore,
} from "./ports.js";

const INTRINSIC_MODEL_COLUMNS = {
  DCF_FCFF: "dcfFcff",
  RESIDUAL_INCOME: "residualIncome",
  DDM: "ddm",
  GRAHAM: "graham",
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
  dcfFcff: DecimalLike | null;
  residualIncome: DecimalLike | null;
  ddm: DecimalLike | null;
  graham: DecimalLike | null;
  blendBalanced: DecimalLike | null;
  blendConservative: DecimalLike | null;
  blendDividend: DecimalLike | null;
  intrinsicSourceDataAsOf: Date | null;
  intrinsicCurrency: string | null;
};

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
    ...(Object.keys(intrinsicValues).length === 0 ? {} : { intrinsicValues }),
    ...(Object.keys(intrinsicValueBlends).length === 0
      ? {}
      : { intrinsicValueBlends }),
    ...(row.intrinsicSourceDataAsOf === null
      ? {}
      : {
          intrinsicSourceDataAsOf: row.intrinsicSourceDataAsOf.toISOString(),
        }),
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
    dcfFcff: row.intrinsicValues?.DCF_FCFF ?? null,
    residualIncome: row.intrinsicValues?.RESIDUAL_INCOME ?? null,
    ddm: row.intrinsicValues?.DDM ?? null,
    graham: row.intrinsicValues?.GRAHAM ?? null,
    blendBalanced: row.intrinsicValueBlends?.BALANCED ?? null,
    blendConservative: row.intrinsicValueBlends?.CONSERVATIVE ?? null,
    blendDividend: row.intrinsicValueBlends?.DIVIDEND ?? null,
    intrinsicSourceDataAsOf: row.intrinsicSourceDataAsOf
      ? new Date(row.intrinsicSourceDataAsOf)
      : null,
    intrinsicCurrency: row.intrinsicCurrency ?? null,
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
  return createHash("sha256")
    .update(stableStringify(canonical))
    .digest("hex");
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
    return [FinancialPeriodEnum.Q1, FinancialPeriodEnum.Q2, FinancialPeriodEnum.Q3, FinancialPeriodEnum.Q4];
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

export class PrismaStockDataStore implements StockDataStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findSecurityByProviderSymbol(symbol: string): Promise<Security | null> {
    const row = await this.prisma.security.findUnique({
      where: { providerSymbol: symbol.trim().toUpperCase() },
    });
    return row ? mapSecurity(row) : null;
  }

  async saveSecurityProfile(
    mapped: MappedFmpProfile,
    syncedAt: string,
  ): Promise<{ security: Security; profile: SecurityProfile }> {
    return this.prisma.$transaction(async (transaction) => {
      const security = await transaction.security.upsert({
        where: { providerSymbol: mapped.providerSymbol },
        create: {
          providerSymbol: mapped.providerSymbol,
          ...mapped.security,
          ...(mapped.security.ipoDate
            ? { ipoDate: toDatabaseDate(mapped.security.ipoDate) }
            : {}),
          type: SecurityType[mapped.security.type],
        },
        update: {
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
      const affectedDates = [...new Set(input.prices.map((price) => toDatabaseDate(price.date)))];
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
      if (input.freshThrough && input.freshThrough >= input.tailDate) {
        await this.advanceFreshnessState(transaction, {
          securityId: input.securityId,
          tailDate: input.tailDate,
          syncedAt: input.syncedAt,
        });
      }
      input.assertOwned?.();
    });
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
          data: input.rows.map((row) => dailyDerivedStateToRow(
            input.securityId,
            row,
          )),
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
    });
  }

  async getWeeklyPrices(securityId: string, range: DateRange) {
    const rows = await this.prisma.weeklyPrice.findMany({
      where: { securityId, weekStartDate: rangeWhere(range) },
      orderBy: { weekStartDate: "asc" },
    });
    return rows.map((row) => ({
      securityId,
      weekStartDate: fromDatabaseDate(row.weekStartDate),
      weekEndDate: fromDatabaseDate(row.weekEndDate),
      eligibleDate: fromDatabaseDate(row.eligibleDate),
      open: row.open.toNumber(),
      high: row.high.toNumber(),
      low: row.low.toNumber(),
      close: row.close.toNumber(),
      volume: Number(row.volume),
    }));
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
        ...(query.from ? { fiscalDate: { gte: toDatabaseDate(query.from) } } : {}),
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
    return selectFinancialStatements(rows.map(financialStatementFromRow), query);
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

      for (const statement of input.statements) {
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
        if (existingByRevision.has(revisionKey) || plannedRevisions.has(revisionKey)) {
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
        const latestKnownFilingDate = latestKnownFilingDateByIdentity.get(identity);
        const canUseInitialAvailability =
          !latestKnownFilingDate || filingDate.valueOf() > latestKnownFilingDate.valueOf();
        const availableFromDate = canUseInitialAvailability
          ? new Date(filingDate.valueOf() + 24 * 60 * 60 * 1_000)
          : new Date(
              Math.max(
                filingDate.valueOf() + 24 * 60 * 60 * 1_000,
                observedAtCalendarDate.valueOf(),
              ),
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
        if (!knownFilingDate || filingDate.valueOf() > knownFilingDate.valueOf()) {
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
    });
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
              statementType:
                FinancialStatementTypeEnum[input.statementType],
            }
          : {}),
        ...(statementPeriods(input.cadence)
          ? { period: { in: statementPeriods(input.cadence) } }
          : {}),
        ...(input.from
          ? { fiscalDate: { gte: toDatabaseDate(input.from) } }
          : {}),
        ...(input.to ? { fiscalDate: { lte: toDatabaseDate(input.to) } } : {}),
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
