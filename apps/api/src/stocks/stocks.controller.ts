import {
  findSelectableSeries,
  TECHNICAL_SERIES,
  type DailyPriceResponse,
  type DailyTechnicalResponse,
  type IntrinsicValueBlendResponse,
  type IntrinsicValueResponse,
  type SecurityProfileResponse,
  type SecurityResponse,
  type StockDetailsResponse,
  type StockHistoryBoundsResponse,
  type StockSearchResultResponse,
} from "@intrinsic/contracts";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  TECHNICAL_SERIES_FIELDS,
  type DateRange,
  type IntrinsicValueBlendId,
  type IntrinsicValueModel,
  type Security,
  type StockDataService,
  type TechnicalSeriesField,
} from "@intrinsic/domain";
import {
  isLocalDate,
  StockDataNotFoundError,
  StockDataValidationError,
} from "@intrinsic/stock-data";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  STOCK_DATA_SERVICE,
  STOCK_DETAILS_RETENTION_YEARS,
} from "./stock-data.tokens";
import {
  clampStockDetailsRange,
  stockDetailsHistoryBounds,
} from "./stock-details-history";

function range(from?: string, to?: string, required = false): DateRange {
  if (required && (!from || !to)) {
    throw new BadRequestException("from and to are required");
  }
  if (from && !isLocalDate(from)) {
    throw new BadRequestException("from must be a valid YYYY-MM-DD date");
  }
  if (to && !isLocalDate(to)) {
    throw new BadRequestException("to must be a valid YYYY-MM-DD date");
  }
  if (from && to && from > to) {
    throw new BadRequestException("from must not be after to");
  }
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function asOf(value?: string): string | undefined {
  if (value && !isLocalDate(value)) {
    throw new BadRequestException("asOf must be a valid YYYY-MM-DD date");
  }
  return value;
}

/** Splits a repeated or comma-separated query parameter into its non-empty values. */
function selectionValues(
  raw: string | string[] | undefined,
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return (Array.isArray(raw) ? raw : raw.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function selections<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  name: string,
): T[] | undefined {
  const values = selectionValues(raw);
  if (values === undefined) {
    return undefined;
  }
  if (values.some((value) => !allowed.includes(value as T))) {
    throw new BadRequestException(`Unsupported ${name}`);
  }
  return values as T[];
}

function securityResponse(
  security: Awaited<ReturnType<StockDataService["getSecurity"]>>,
): SecurityResponse {
  return {
    id: security.id,
    symbol: security.symbol,
    name: security.name,
    exchangeCode: security.exchangeCode,
    ...(security.exchangeName ? { exchangeName: security.exchangeName } : {}),
    currency: security.currency,
    ...(security.cik ? { cik: security.cik } : {}),
    ...(security.isin ? { isin: security.isin } : {}),
    ...(security.cusip ? { cusip: security.cusip } : {}),
    ...(security.country ? { country: security.country } : {}),
    ...(security.sector ? { sector: security.sector } : {}),
    ...(security.industry ? { industry: security.industry } : {}),
    ...(security.ipoDate ? { ipoDate: security.ipoDate } : {}),
    type: security.type,
    isAdr: security.isAdr,
    isActivelyTrading: security.isActivelyTrading,
  };
}

function searchResultResponse(security: Security): StockSearchResultResponse {
  return {
    id: security.id,
    symbol: security.symbol,
    name: security.name,
    exchangeCode: security.exchangeCode,
    ...(security.exchangeName ? { exchangeName: security.exchangeName } : {}),
  };
}

function profileResponse(
  profile: NonNullable<
    Awaited<ReturnType<StockDataService["getStockDetails"]>>["profile"]
  >,
): SecurityProfileResponse {
  return {
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.website ? { website: profile.website } : {}),
    ...(profile.logoUrl ? { logoUrl: profile.logoUrl } : {}),
    ...(profile.ceo ? { ceo: profile.ceo } : {}),
    ...(profile.employees === undefined
      ? {}
      : { employees: profile.employees }),
  };
}

function priceResponse(
  price: Awaited<ReturnType<StockDataService["getDailyPrices"]>>[number],
): DailyPriceResponse {
  return {
    date: price.date,
    open: price.open,
    high: price.high,
    low: price.low,
    close: price.close,
    volume: price.volume,
    ...(price.vwap === undefined ? {} : { vwap: price.vwap }),
  };
}

/**
 * Projects one daily technical row onto the wire contract.
 *
 * Every technical series — both moving-average timeframes and the daily oscillators — is copied
 * through the canonical field list, so adding a catalog series can never leave it silently missing
 * from the API. Nothing is calculated here: controllers project canonical stock-data values and
 * never compute financial or technical series. `fields` restricts the projection to a validated
 * selection; unavailable values are omitted rather than zeroed either way.
 */
function technicalResponse(
  technical: Awaited<
    ReturnType<StockDataService["getDailyTechnicals"]>
  >[number],
  fields?: readonly TechnicalSeriesField[],
): DailyTechnicalResponse {
  const selected = fields ?? TECHNICAL_SERIES_FIELDS;
  return {
    date: technical.date,
    ...Object.fromEntries(
      selected.flatMap((field) => {
        const value = technical[field as keyof typeof technical];
        return typeof value === "number" ? [[field, value] as const] : [];
      }),
    ),
  };
}

/**
 * Resolves a `series` filter against the canonical selectable-series catalog.
 *
 * Moving-average and oscillator entries are addressable here: the intrinsic-value entries of the
 * catalog are served by the intrinsic-value and blend endpoints, which apply their own
 * point-in-time rules. An unknown or non-technical identifier is rejected rather than silently
 * ignored.
 */
function technicalFields(
  raw: string | string[] | undefined,
): TechnicalSeriesField[] | undefined {
  const ids = selectionValues(raw);
  if (ids === undefined) {
    return undefined;
  }
  return ids.map((id) => {
    const entry = findSelectableSeries(id);
    if (
      !entry ||
      (entry.source.kind !== "MOVING_AVERAGE" &&
        entry.source.kind !== "OSCILLATOR")
    ) {
      throw new BadRequestException(
        `Unsupported technical series. Supported: ${TECHNICAL_SERIES.map(
          (series) => series.id,
        ).join(", ")}`,
      );
    }
    return entry.source.field as TechnicalSeriesField;
  });
}

function intrinsicResponse(
  point: Awaited<ReturnType<StockDataService["getIntrinsicValues"]>>[number],
): IntrinsicValueResponse {
  return {
    valuationDate: point.valuationDate,
    sourceDataAsOf: point.sourceDataAsOf,
    model: point.model,
    valuePerShare: point.valuePerShare,
    currency: point.currency,
  };
}

function blendResponse(
  point: Awaited<
    ReturnType<StockDataService["getIntrinsicValueBlends"]>
  >[number],
): IntrinsicValueBlendResponse {
  return {
    valuationDate: point.valuationDate,
    sourceDataAsOf: point.sourceDataAsOf,
    blendId: point.blendId,
    valuePerShare: point.valuePerShare,
    currency: point.currency,
  };
}

@Controller("stocks")
export class StocksController {
  constructor(
    @Inject(STOCK_DATA_SERVICE)
    private readonly stocks: StockDataService,
    @Inject(STOCK_DETAILS_RETENTION_YEARS)
    private readonly retentionYears: number,
  ) {}

  /**
   * The bound every Stock Details read is clamped to, before any security is resolved.
   *
   * Only the horizon half is knowable here; the listing date narrows the bound this surface
   * *reports*, and the canonical loader applies it to what it materializes. Clamping the
   * horizon at the edge is what keeps a hand-written `from=1900-01-01` from turning into an
   * unbounded backend request.
   */
  private horizonBounds(): StockHistoryBoundsResponse {
    return stockDetailsHistoryBounds({
      today: new Date().toISOString().slice(0, 10),
      retentionYears: this.retentionYears,
    });
  }

  /**
   * Global stock search.
   *
   * Declared before `:symbol` on purpose: Nest matches routes in declaration order, so moving this
   * handler below the parameterised routes would make `/stocks/search` resolve as a symbol lookup
   * for a security named "search". `stocks.search.integration.test.ts` locks that ordering in.
   */
  @Get("search")
  async searchStocks(
    @Query("q") q?: string,
  ): Promise<StockSearchResultResponse[]> {
    const term = (q ?? "").trim();
    if (term === "") {
      throw new BadRequestException("q is required");
    }
    return this.execute(async () =>
      (await this.stocks.searchSecurities({ term })).map(searchResultResponse),
    );
  }

  @Get(":symbol")
  async getStockDetails(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<StockDetailsResponse> {
    const horizon = this.horizonBounds();
    const query = clampStockDetailsRange(range(from, to), horizon);
    return this.execute(async () => {
      const details = await this.stocks.getStockDetails(symbol, query);
      return {
        security: securityResponse(details.security),
        ...(details.profile
          ? { profile: profileResponse(details.profile) }
          : {}),
        // Reported by the loader, which owns the clock and the retained horizon. The clamp above
        // is the surface's own coarse guard; the bound a client navigates by is the one the
        // loader will actually honour.
        history: details.history,
        prices: details.prices.map(priceResponse),
        technicals: details.technicals.map((technical) =>
          technicalResponse(technical),
        ),
        intrinsicValues: details.intrinsicValues.map(intrinsicResponse),
        intrinsicValueBlends: details.intrinsicValueBlends.map(blendResponse),
      };
    });
  }

  @Get(":symbol/prices")
  async getDailyPrices(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<DailyPriceResponse[]> {
    const query = clampStockDetailsRange(range(from, to, true), this.horizonBounds());
    return this.execute(async () =>
      (await this.stocks.getDailyPrices(symbol, query)).map(priceResponse),
    );
  }

  /**
   * Daily technical history, including the weekly moving averages carried forward onto each
   * trading day. `series` optionally narrows the response to catalog moving-average identities;
   * omitting it keeps the pre-existing full projection.
   */
  @Get(":symbol/technicals/daily")
  async getDailyTechnicals(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("series") seriesQuery?: string | string[],
  ): Promise<DailyTechnicalResponse[]> {
    const query = clampStockDetailsRange(range(from, to, true), this.horizonBounds());
    const fields = technicalFields(seriesQuery);
    return this.execute(async () =>
      (await this.stocks.getDailyTechnicals(symbol, query)).map((technical) =>
        technicalResponse(technical, fields),
      ),
    );
  }

  @Get(":symbol/intrinsic-values")
  async getIntrinsicValues(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("asOf") asOfQuery?: string,
    @Query("models") modelsQuery?: string | string[],
  ): Promise<IntrinsicValueResponse[]> {
    const query = clampStockDetailsRange(range(from, to), this.horizonBounds());
    const models = selections<IntrinsicValueModel>(
      modelsQuery,
      INTRINSIC_VALUE_MODELS,
      "intrinsic-value model",
    );
    const cutoff = asOf(asOfQuery);
    return this.execute(async () =>
      (
        await this.stocks.getIntrinsicValues(symbol, {
          ...query,
          ...(cutoff ? { asOf: cutoff } : {}),
          ...(models ? { models } : {}),
        })
      ).map(intrinsicResponse),
    );
  }

  @Get(":symbol/intrinsic-value-blends")
  async getIntrinsicValueBlends(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("asOf") asOfQuery?: string,
    @Query("blendIds") blendsQuery?: string | string[],
  ): Promise<IntrinsicValueBlendResponse[]> {
    const query = clampStockDetailsRange(range(from, to), this.horizonBounds());
    const blendIds = selections<IntrinsicValueBlendId>(
      blendsQuery,
      INTRINSIC_VALUE_BLEND_IDS,
      "intrinsic-value blend",
    );
    const cutoff = asOf(asOfQuery);
    return this.execute(async () =>
      (
        await this.stocks.getIntrinsicValueBlends(symbol, {
          ...query,
          ...(cutoff ? { asOf: cutoff } : {}),
          ...(blendIds ? { blendIds } : {}),
        })
      ).map(blendResponse),
    );
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof StockDataNotFoundError) {
        throw new NotFoundException("Stock symbol was not found");
      }
      if (error instanceof StockDataValidationError) {
        throw new BadRequestException(error.message);
      }
      throw new ServiceUnavailableException(
        "Stock data is temporarily unavailable",
      );
    }
  }
}
