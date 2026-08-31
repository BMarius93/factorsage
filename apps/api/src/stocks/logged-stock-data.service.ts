import type {
  DailyDerivedState,
  DateRange,
  FinancialStatement,
  FinancialStatementQuery,
  IntrinsicValueBlendPoint,
  IntrinsicValueBlendQuery,
  IntrinsicValuePoint,
  IntrinsicValueQuery,
  Security,
  SecuritySearchQuery,
  StockDetails,
  StockDataService,
  DailyPrice,
  DailyTechnical,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  StockDataNotFoundError,
  StockDataValidationError,
} from "@intrinsic/stock-data";

export class LoggedStockDataService implements StockDataService {
  constructor(
    private readonly delegate: StockDataService,
    private readonly logger: StructuredLogger,
  ) {}

  getSecurity(symbol: string): Promise<Security> {
    return this.execute("getSecurity", symbol, () =>
      this.delegate.getSecurity(symbol),
    );
  }

  async searchSecurities(query: SecuritySearchQuery): Promise<Security[]> {
    const startedAt = Date.now();
    try {
      return await this.delegate.searchSecurities(query);
    } catch (err) {
      this.logger.error({
        event: "stock.search.failed",
        operation: "searchSecurities",
        // The raw term is user input, not credentials; its length alone would hide the cause.
        query: query.term.trim(),
        durationMs: Date.now() - startedAt,
        err,
      });
      throw err;
    }
  }

  getStockDetails(symbol: string, range?: DateRange): Promise<StockDetails> {
    return this.execute("getStockDetails", symbol, () =>
      this.delegate.getStockDetails(symbol, range),
    );
  }

  getDailyPrices(symbol: string, range: DateRange): Promise<DailyPrice[]> {
    return this.execute("getDailyPrices", symbol, () =>
      this.delegate.getDailyPrices(symbol, range),
    );
  }

  getDailyDerivedState(
    symbol: string,
    range: DateRange,
  ): Promise<DailyDerivedState[]> {
    return this.execute("getDailyDerivedState", symbol, () =>
      this.delegate.getDailyDerivedState(symbol, range),
    );
  }

  getDailyTechnicals(
    symbol: string,
    range: DateRange,
  ): Promise<DailyTechnical[]> {
    return this.execute("getDailyTechnicals", symbol, () =>
      this.delegate.getDailyTechnicals(symbol, range),
    );
  }

  getFinancialStatements(
    symbol: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[]> {
    return this.execute("getFinancialStatements", symbol, () =>
      this.delegate.getFinancialStatements(symbol, query),
    );
  }

  getIntrinsicValues(
    symbol: string,
    query: IntrinsicValueQuery,
  ): Promise<IntrinsicValuePoint[]> {
    return this.execute("getIntrinsicValues", symbol, () =>
      this.delegate.getIntrinsicValues(symbol, query),
    );
  }

  getIntrinsicValueBlends(
    symbol: string,
    query: IntrinsicValueBlendQuery,
  ): Promise<IntrinsicValueBlendPoint[]> {
    return this.execute("getIntrinsicValueBlends", symbol, () =>
      this.delegate.getIntrinsicValueBlends(symbol, query),
    );
  }

  private async execute<T>(
    operation: string,
    symbol: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await action();
    } catch (err) {
      const fields = {
        event: "stock.data.operation.failed",
        operation,
        symbol: symbol.trim().toUpperCase(),
        durationMs: Date.now() - startedAt,
        err,
      };

      if (
        err instanceof StockDataNotFoundError ||
        err instanceof StockDataValidationError
      ) {
        this.logger.warn(fields);
      } else {
        this.logger.error(fields);
      }
      throw err;
    }
  }
}
