import type {
  Security,
  SecuritySearchQuery,
  StockDataService,
} from "@intrinsic/domain";
import { StockDataNotFoundError } from "@intrinsic/stock-data";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STOCK_DATA_SERVICE } from "./stock-data.tokens";
import { StocksController } from "./stocks.controller";

/**
 * HTTP-level contract for the global stock search.
 *
 * Only the controller is wired here: the search route's real risk is Nest routing and request
 * translation, not persistence, and the stock-data module would otherwise pull in PostgreSQL and
 * Redis. Matching and ranking are covered by `@intrinsic/stock-data`'s `security-search` tests.
 */

function security(symbol: string, name: string): Security {
  return {
    id: `id-${symbol}`,
    symbol,
    name,
    exchangeCode: "NASDAQ",
    exchangeName: "NASDAQ Global Select",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
  };
}

class FakeStockDataService {
  searchCalls: SecuritySearchQuery[] = [];
  detailsCalls: string[] = [];
  searchResults: Security[] = [];
  searchError: Error | null = null;

  async searchSecurities(query: SecuritySearchQuery): Promise<Security[]> {
    this.searchCalls.push(query);
    if (this.searchError) {
      throw this.searchError;
    }
    return this.searchResults;
  }

  async getStockDetails(symbol: string) {
    this.detailsCalls.push(symbol);
    throw new StockDataNotFoundError(symbol);
  }
}

describe("GET /stocks/search", () => {
  let app: INestApplication;
  let service: FakeStockDataService;

  beforeAll(async () => {
    service = new FakeStockDataService();
    const moduleRef = await Test.createTestingModule({
      controllers: [StocksController],
      providers: [
        {
          provide: STOCK_DATA_SERVICE,
          useValue: service as unknown as StockDataService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.searchCalls = [];
    service.detailsCalls = [];
    service.searchResults = [];
    service.searchError = null;
  });

  it("routes /stocks/search to the search handler instead of the :symbol lookup", async () => {
    service.searchResults = [security("AAPL", "Apple Inc.")];

    const response = await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: "aapl" })
      .expect(200);

    expect(service.searchCalls).toEqual([{ term: "aapl" }]);
    expect(service.detailsCalls).toEqual([]);
    expect(response.body).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
      },
    ]);
  });

  it("still resolves a real symbol through the :symbol route", async () => {
    await request(app.getHttpServer()).get("/stocks/AAPL").expect(404);

    expect(service.detailsCalls).toEqual(["AAPL"]);
    expect(service.searchCalls).toEqual([]);
  });

  it("trims the query before delegating", async () => {
    await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: "  msft  " })
      .expect(200);

    expect(service.searchCalls).toEqual([{ term: "msft" }]);
  });

  it("rejects a missing or blank query without touching the service", async () => {
    await request(app.getHttpServer()).get("/stocks/search").expect(400);
    await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: "   " })
      .expect(400);

    expect(service.searchCalls).toEqual([]);
  });

  it("omits an unknown exchange name rather than emitting null", async () => {
    service.searchResults = [
      { ...security("NVDA", "NVIDIA Corporation"), exchangeName: undefined },
    ];

    const response = await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: "nvda" })
      .expect(200);

    expect(response.body).toEqual([
      { symbol: "NVDA", name: "NVIDIA Corporation", exchangeCode: "NASDAQ" },
    ]);
  });

  it("reports an unavailable search as 503 rather than a bad request", async () => {
    service.searchError = new Error("database unreachable");

    await request(app.getHttpServer())
      .get("/stocks/search")
      .query({ q: "aapl" })
      .expect(503);
  });
});
