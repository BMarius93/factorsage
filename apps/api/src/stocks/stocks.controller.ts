import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendResponse,
  IntrinsicValueResponse,
  SecurityProfileResponse,
  SecurityResponse,
  StockDetailsResponse,
} from "@intrinsic/contracts";
import {
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  type DateRange,
  type IntrinsicValueBlendId,
  type IntrinsicValueModel,
  type StockDataService,
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
import { STOCK_DATA_SERVICE } from "./stock-data.tokens";

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

function selections<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  name: string,
): T[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = (Array.isArray(raw) ? raw : raw.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
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

function technicalResponse(
  technical: Awaited<
    ReturnType<StockDataService["getDailyTechnicals"]>
  >[number],
): DailyTechnicalResponse {
  return {
    date: technical.date,
    ...(technical.sma20d === undefined ? {} : { sma20d: technical.sma20d }),
    ...(technical.sma50d === undefined ? {} : { sma50d: technical.sma50d }),
    ...(technical.sma100d === undefined ? {} : { sma100d: technical.sma100d }),
    ...(technical.sma200d === undefined ? {} : { sma200d: technical.sma200d }),
    ...(technical.ema20d === undefined ? {} : { ema20d: technical.ema20d }),
    ...(technical.ema50d === undefined ? {} : { ema50d: technical.ema50d }),
    ...(technical.ema200d === undefined ? {} : { ema200d: technical.ema200d }),
  };
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
  ) {}

  @Get(":symbol")
  async getStockDetails(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<StockDetailsResponse> {
    const query = range(from, to);
    return this.execute(async () => {
      const details = await this.stocks.getStockDetails(symbol, query);
      return {
        security: securityResponse(details.security),
        ...(details.profile
          ? { profile: profileResponse(details.profile) }
          : {}),
        prices: details.prices.map(priceResponse),
        technicals: details.technicals.map(technicalResponse),
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
    const query = range(from, to, true);
    return this.execute(async () =>
      (await this.stocks.getDailyPrices(symbol, query)).map(priceResponse),
    );
  }

  @Get(":symbol/technicals/daily")
  async getDailyTechnicals(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<DailyTechnicalResponse[]> {
    const query = range(from, to, true);
    return this.execute(async () =>
      (await this.stocks.getDailyTechnicals(symbol, query)).map(
        technicalResponse,
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
    const query = range(from, to);
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
    const query = range(from, to);
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
