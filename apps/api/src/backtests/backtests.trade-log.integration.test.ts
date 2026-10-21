import { createHash, randomUUID } from "node:crypto";
import { get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { loadRootEnv } from "@intrinsic/config";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type BacktestRunDetailResponse,
  type BacktestTradeAction,
  type BacktestTradePageResponse,
  type BacktestTradeSource,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { BacktestsModule } from "./backtests.module";
import { BacktestsService } from "./backtests.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * The trade log a reader can narrow, turn around and take away: HTTP -> Nest -> BacktestsService
 * -> real PostgreSQL.
 *
 * A run is seeded with a few thousand trades across four stocks and every kind of action, the
 * end-of-backtest liquidations included, so a filter that only looked at the rows on one page — or
 * an export that only wrote the rendered page — would visibly disagree with the whole log. Every
 * expectation is computed from the seeded rows themselves, never from what the API answered.
 *
 * No worker runs: the run is submitted through the real route (so it carries a real snapshot), then
 * marked completed with its trades written directly — exactly the rows a worker produces.
 */
describe("the filtered, sortable and exportable trade log", () => {
  const suffix = randomUUID();
  const shortSuffix = suffix.slice(0, 8).toUpperCase();
  const password = "Local-test-password-42";
  const ownerEmail = `trade-log-owner-${suffix}@example.test`;
  const otherEmail = `trade-log-other-${suffix}@example.test`;
  const letters = ["D", "B", "A", "C"] as const;
  const providerSymbols = letters.map((letter) => `TL${letter}-${suffix}`);

  /** More than one export batch, and many pages at every page size. */
  const TRADE_COUNT = 2_404;

  let app: INestApplication;
  let prisma: PrismaService;
  let service: BacktestsService;
  let owner: ReturnType<typeof request.agent>;
  let other: ReturnType<typeof request.agent>;
  let runId = "";

  function symbolOf(letter: string): string {
    return `TL${letter}${shortSuffix}`;
  }

  /** One company name a spreadsheet would execute, one that needs quoting, one that is not ASCII. */
  const NAMES: Record<(typeof letters)[number], string> = {
    A: "Alpha Industries",
    B: "=Formula Corp, Inc.",
    C: "Société Générale",
    D: 'Delta "Quoted" Holdings',
  };

  const definition: StrategyDefinition = normalizeStrategyDefinition({
    schemaVersion: 2,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "buy-condition",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "EMA_200D" },
            },
          ],
        },
      },
    ],
    sellLevels: [
      {
        id: "sell-1",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "sell-condition",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
          ],
        },
      },
    ],
    finalExit: {
      id: "final-exit",
      rules: [
        {
          id: "exit-rule-1",
          signal: {
            conditions: [
              {
                id: "exit-condition",
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
      ],
    },
  });

  type Seeded = {
    sequence: number;
    date: string;
    letter: (typeof letters)[number];
    symbol: string;
    name: string;
    action: BacktestTradeAction;
    source: BacktestTradeSource;
    levelId: string | null;
    exitRuleId: string | null;
    levelPercentage: number | null;
    shares: string;
    price: string;
    amount: string;
    realizedPnl: string | null;
    realizedPnlPercent: string | null;
  };

  /**
   * The ledger, in execution order. Three trades share each date, so only `sequence` can order
   * them; the last four are the end-of-backtest liquidations, one per stock. Symbols cycle by four
   * and strategy actions by three, so every stock carries every action.
   *
   * Every decimal is written at its column's scale with a non-zero last digit, so the exact text
   * the export must print is the text seeded here.
   */
  const seeded: Seeded[] = Array.from({ length: TRADE_COUNT }, (_, index) => {
    const sequence = index + 1;
    const liquidation = index >= TRADE_COUNT - letters.length;
    const letter = letters[index % letters.length] as (typeof letters)[number];
    const action: BacktestTradeAction = liquidation
      ? "SELL"
      : index % 3 === 0
        ? "BUY"
        : index % 3 === 1
          ? "SELL"
          : "FINAL_EXIT";
    const sale = action !== "BUY";
    const sign = index % 2 === 0 ? "-" : "";
    const day = new Date(Date.UTC(2012, 0, 2));
    day.setUTCDate(day.getUTCDate() + Math.floor(index / 3));
    return {
      sequence,
      date: day.toISOString().slice(0, 10),
      letter,
      symbol: symbolOf(letter),
      name: NAMES[letter],
      action,
      source: liquidation ? "END_OF_BACKTEST" : "STRATEGY",
      levelId: liquidation
        ? null
        : action === "BUY"
          ? "buy-1"
          : action === "SELL"
            ? "sell-1"
            : "final-exit",
      exitRuleId: action === "FINAL_EXIT" ? "exit-rule-1" : null,
      levelPercentage: liquidation
        ? null
        : action === "BUY"
          ? 25
          : action === "SELL"
            ? 50
            : null,
      shares: `${(index % 97) + 1}.1234567891`,
      price: `${100 + (index % 50)}.12345678`,
      amount: `${1_000 + index}.123456`,
      realizedPnl: sale ? `${sign}${index}.5` : null,
      realizedPnlPercent: sale ? `${sign}${index % 90}.25` : null,
    };
  });

  function expectedSequences(filter: {
    symbol?: string;
    action?: BacktestTradeAction;
    order?: "asc" | "desc";
  }): number[] {
    const matched = seeded
      .filter(
        (trade) =>
          (filter.symbol === undefined || trade.symbol === filter.symbol) &&
          (filter.action === undefined || trade.action === filter.action),
      )
      .map((trade) => trade.sequence);
    return filter.order === "asc" ? matched : matched.reverse();
  }

  async function page(query: string): Promise<BacktestTradePageResponse> {
    const response = await owner
      .get(`/backtests/${runId}/trades${query}`)
      .expect(200);
    return response.body as BacktestTradePageResponse;
  }

  /** Every page of one filter, walked the way the browser walks them. */
  async function allPages(
    query: string,
    pageSize: number,
  ): Promise<{ pages: BacktestTradePageResponse[]; sequences: number[] }> {
    const pages: BacktestTradePageResponse[] = [];
    for (let index = 1; ; index += 1) {
      const body = await page(
        `?${query}${query ? "&" : ""}page=${index}&pageSize=${pageSize}`,
      );
      pages.push(body);
      if (body.page >= body.pageCount) {
        break;
      }
    }
    return {
      pages,
      sequences: pages.flatMap((body) =>
        body.items.map((trade) => trade.sequence),
      ),
    };
  }

  /** The response body as bytes: the byte-order mark must be checked before any decoding. */
  function binary(
    response: request.Response,
    callback: (error: Error | null, body: Buffer) => void,
  ): void {
    // Under Node, the response a parser receives is the incoming message stream itself.
    const stream = response as unknown as IncomingMessage;
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (error: Error | null) => {
      if (!settled) {
        settled = true;
        callback(error, Buffer.concat(chunks));
      }
    };
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A response cut off mid-body is aborted, never ended: that is the signal a download failed.
    stream.on("aborted", () => settle(new Error("response aborted")));
    stream.on("error", (error) => settle(error));
    stream.on("end", () =>
      settle(stream.complete ? null : new Error("response incomplete")),
    );
  }

  /** RFC 4180 fields of one record (no record in this suite spans lines). */
  function fieldsOf(record: string): string[] {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < record.length; index += 1) {
      const character = record[index];
      if (quoted) {
        if (character === '"') {
          if (record[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          field += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        fields.push(field);
        field = "";
      } else {
        field += character;
      }
    }
    fields.push(field);
    return fields;
  }

  async function exportCsv(query = ""): Promise<{
    response: request.Response;
    header: string[];
    rows: string[][];
    text: string;
  }> {
    const response = await owner
      .get(`/backtests/${runId}/trades/export${query}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const bytes = response.body as Buffer;
    // UTF-8 byte-order mark, so a spreadsheet decodes the non-ASCII names as UTF-8.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text.endsWith("\r\n")).toBe(true);
    const records = text.slice(0, -2).split("\r\n");
    return {
      response,
      text,
      header: fieldsOf(records[0] ?? ""),
      rows: records.slice(1).map(fieldsOf),
    };
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        BacktestsModule,
        BenchmarksModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Loopback, never a wildcard ephemeral port (TEST-001; see `backtests.integration.test.ts`).
    await app.listen(0, "127.0.0.1");

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(BacktestsService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: ownerEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
        { email: otherEmail, passwordHash, emailVerifiedAt, plan: "PRO" },
      ],
    });
    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
      select: { id: true },
    });

    const securityIds = new Map<string, string>();
    for (const letter of letters) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `TL${letter}-${suffix}`,
          symbol: symbolOf(letter),
          name: NAMES[letter],
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true },
      });
      securityIds.set(letter, security.id);
    }

    const strategy = await prisma.strategy.create({
      data: {
        userId: ownerUser.id,
        name: "Trade log fixture",
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as unknown as object,
            definitionHash: createHash("sha256")
              .update(strategyDefinitionFingerprint(definition))
              .digest("hex"),
          },
        },
      },
    });
    const list = await prisma.stockList.create({
      data: { userId: ownerUser.id, name: "Trade log universe" },
    });
    for (const letter of letters) {
      await prisma.stockListItem.create({
        data: {
          stockListId: list.id,
          securityId: securityIds.get(letter) ?? "",
          buyWindowMode: "FULL",
        },
      });
    }

    owner = request.agent(app.getHttpServer());
    other = request.agent(app.getHttpServer());
    await owner
      .post("/auth/login")
      .send({ email: ownerEmail, password })
      .expect(200);
    await other
      .post("/auth/login")
      .send({ email: otherEmail, password })
      .expect(200);

    const submitted = await owner
      .post("/backtests")
      .send({
        strategyId: strategy.id,
        stockListId: list.id,
        startDate: "2012-01-02",
        endDate: "2016-12-30",
        initialCapital: 100_000,
        monthlyContribution: 0,
        maximumPositions: 10,
      })
      .expect(202);
    runId = (submitted.body as BacktestRunDetailResponse).id;
    // Completed, and its job settled, so no worker sharing the test database can claim it.
    await prisma.backtestRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        startedAt: new Date(),
        completedAt: new Date(),
        job: { update: { status: "COMPLETED" } },
      },
    });
    for (let start = 0; start < seeded.length; start += 500) {
      await prisma.backtestTrade.createMany({
        data: seeded.slice(start, start + 500).map((trade) => ({
          runId,
          sequence: trade.sequence,
          date: new Date(`${trade.date}T00:00:00.000Z`),
          securityId: securityIds.get(trade.letter) ?? "",
          symbol: trade.symbol,
          name: trade.name,
          action: trade.action,
          source: trade.source,
          levelId: trade.levelId,
          exitRuleId: trade.exitRuleId,
          levelPercentage: trade.levelPercentage,
          shares: trade.shares,
          price: trade.price,
          amount: trade.amount,
          fees: 0,
          realizedPnl: trade.realizedPnl,
          realizedPnlPercent: trade.realizedPnlPercent,
          cashAfter: 1_000,
          sharesAfter: 1,
          averageCostAfter: 100,
        })),
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      // Runs, jobs and trades cascade from the users; trades restrict their securities, so the
      // users go first.
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
      await prisma.security.deleteMany({
        where: { providerSymbol: { in: providerSymbols } },
      });
    }
    if (app) {
      await app.close();
    }
  });

  describe("the page", () => {
    it("is unchanged without a filter: newest first, every trade counted, every stock offered", async () => {
      const first = await page("");
      expect(first.totalCount).toBe(TRADE_COUNT);
      expect(first.unfilteredCount).toBe(TRADE_COUNT);
      expect(first.pageCount).toBe(Math.ceil(TRADE_COUNT / 50));
      expect(first.items.map((trade) => trade.sequence)).toEqual(
        expectedSequences({}).slice(0, 50),
      );
      expect(first).toMatchObject({
        symbol: null,
        action: null,
        order: "desc",
      });
      // Sorted, distinct, and not the order the stocks were created or traded in.
      expect(first.symbols).toEqual(
        ["A", "B", "C", "D"].map((letter) => symbolOf(letter)),
      );
    });

    it("filters to one stock across every page, with the filtered counts", async () => {
      const symbol = symbolOf("B");
      const expected = expectedSequences({ symbol });
      const { pages, sequences } = await allPages(`symbol=${symbol}`, 200);

      expect(sequences).toEqual(expected);
      for (const body of pages) {
        expect(body.totalCount).toBe(expected.length);
        expect(body.pageCount).toBe(Math.ceil(expected.length / 200));
        expect(body.unfilteredCount).toBe(TRADE_COUNT);
        expect(body.symbol).toBe(symbol);
        // The options never shrink to the filter they were chosen from.
        expect(body.symbols).toHaveLength(4);
        expect(body.items.every((trade) => trade.symbol === symbol)).toBe(true);
      }
    });

    it("counts the end-of-backtest liquidations as sells, and never as final exits", async () => {
      const sells = await allPages("action=SELL", 200);
      expect(sells.sequences).toEqual(expectedSequences({ action: "SELL" }));
      const liquidations = sells.pages
        .flatMap((body) => body.items)
        .filter((trade) => trade.source === "END_OF_BACKTEST");
      expect(liquidations).toHaveLength(letters.length);
      expect(
        liquidations.every((trade) => trade.reason?.kind === "END_OF_BACKTEST"),
      ).toBe(true);

      const exits = await allPages("action=FINAL_EXIT", 200);
      expect(exits.sequences).toEqual(
        expectedSequences({ action: "FINAL_EXIT" }),
      );
      expect(
        exits.pages
          .flatMap((body) => body.items)
          .every(
            (trade) =>
              trade.action === "FINAL_EXIT" && trade.source === "STRATEGY",
          ),
      ).toBe(true);
    });

    it("combines a stock, an action and oldest first, stable across trades on one date", async () => {
      const symbol = symbolOf("C");
      const expected = expectedSequences({
        symbol,
        action: "BUY",
        order: "asc",
      });
      const { pages, sequences } = await allPages(
        `symbol=${symbol}&action=BUY&order=asc`,
        25,
      );
      expect(sequences).toEqual(expected);
      expect(pages[0]).toMatchObject({
        symbol,
        action: "BUY",
        order: "asc",
        totalCount: expected.length,
      });

      // Oldest first over the whole log: dates never go backwards, and within one date the
      // engine's own execution order decides.
      const oldest = await allPages("order=asc", 200);
      expect(oldest.sequences).toEqual(expectedSequences({ order: "asc" }));
      const items = oldest.pages.flatMap((body) => body.items);
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1];
        const current = items[index];
        expect(
          previous !== undefined &&
            current !== undefined &&
            previous.date <= current.date,
        ).toBe(true);
      }
    });

    it("clamps a page past the end of a filtered log to its last page", async () => {
      const expected = expectedSequences({ action: "FINAL_EXIT" });
      const beyond = await page("?action=FINAL_EXIT&page=9999&pageSize=200");
      expect(beyond.page).toBe(Math.ceil(expected.length / 200));
      expect(beyond.items.at(-1)?.sequence).toBe(expected.at(-1));
    });

    it("ignores a filter it does not recognise, and says so", async () => {
      const ignored = await page("?action=HOLD&order=sideways&symbol=");
      expect(ignored).toMatchObject({
        totalCount: TRADE_COUNT,
        symbol: null,
        action: null,
        order: "desc",
      });
      expect(ignored.items[0]?.sequence).toBe(TRADE_COUNT);
    });

    it("answers a stock the run never traded with an empty log, not an error", async () => {
      const none = await page("?symbol=NOT-TRADED");
      expect(none).toMatchObject({
        items: [],
        page: 1,
        totalCount: 0,
        pageCount: 1,
        unfilteredCount: TRADE_COUNT,
        symbol: "NOT-TRADED",
      });
    });
  });

  describe("the CSV export", () => {
    it("holds exactly the filtered trades, in the order asked for, whatever the page", async () => {
      const symbol = symbolOf("D");
      const expected = expectedSequences({
        symbol,
        action: "SELL",
        order: "asc",
      });
      const { response, header, rows } = await exportCsv(
        `?symbol=${symbol}&action=SELL&order=asc`,
      );

      expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(response.headers["content-disposition"]).toBe(
        `attachment; filename="factorsage-trades-${runId.slice(0, 8)}-${symbol}-sell-oldest-first.csv"`,
      );
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(header).toEqual([
        "Sequence",
        "Date",
        "Symbol",
        "Name",
        "Action",
        "Source",
        "Level %",
        "Shares",
        "Price",
        "Amount",
        "Realized P/L",
        "Realized P/L %",
        "Reason",
      ]);
      expect(rows.map((row) => Number(row[0]))).toEqual(expected);
      // The liquidation is in the file as a sale, like it is in the log.
      expect(rows.at(-1)?.slice(4, 6)).toEqual(["SELL", "END_OF_BACKTEST"]);
      expect(rows.at(-1)?.[12]).toBe("End of backtest");

      // The same trades the paged log returns for the same filter, value for value.
      const paged = await allPages(
        `symbol=${symbol}&action=SELL&order=asc`,
        200,
      );
      const items = paged.pages.flatMap((body) => body.items);
      expect(items).toHaveLength(rows.length);
      items.forEach((trade, index) => {
        const row = rows[index] ?? [];
        expect(Number(row[0])).toBe(trade.sequence);
        expect(row[1]).toBe(trade.date);
        expect(Number(row[7])).toBe(trade.shares);
        expect(Number(row[8])).toBe(trade.price);
        expect(Number(row[9])).toBe(trade.amount);
        expect(row[10] === "" ? null : Number(row[10])).toBe(trade.realizedPnl);
      });
    });

    it("exports the whole log newest first by default, across several read batches", async () => {
      const { response, rows, text } = await exportCsv();
      expect(response.headers["content-disposition"]).toBe(
        `attachment; filename="factorsage-trades-${runId.slice(0, 8)}.csv"`,
      );
      expect(rows).toHaveLength(TRADE_COUNT);
      expect(rows.map((row) => Number(row[0]))).toEqual(expectedSequences({}));

      // Raw values, exactly as stored: ISO dates, unrounded decimals, codes rather than labels.
      const newest = seeded.at(-1) as Seeded;
      const buy = seeded.find((trade) => trade.action === "BUY") as Seeded;
      const buyRow = rows.find((row) => Number(row[0]) === buy.sequence);
      expect(buyRow).toEqual([
        String(buy.sequence),
        buy.date,
        buy.symbol,
        buy.name,
        "BUY",
        "STRATEGY",
        "25",
        buy.shares,
        buy.price,
        buy.amount,
        "",
        "",
        "Price is above EMA 200D",
      ]);
      expect(rows[0]?.slice(0, 7)).toEqual([
        String(newest.sequence),
        newest.date,
        newest.symbol,
        newest.name,
        "SELL",
        "END_OF_BACKTEST",
        "",
      ]);
      // A loss is a plain negative number, never neutralised as if it were a formula.
      const loss = seeded.find(
        (trade) => trade.realizedPnl?.startsWith("-") === true,
      ) as Seeded;
      const lossRow = rows.find((row) => Number(row[0]) === loss.sequence);
      expect(lossRow?.[10]).toBe(loss.realizedPnl);
      expect(text).toContain(`,${loss.realizedPnl},`);

      // Text a spreadsheet would execute is neutralised, and quoted where RFC 4180 needs it.
      expect(text).toContain(`,"'=Formula Corp, Inc.",`);
      expect(text).toContain(',"Delta ""Quoted"" Holdings",');
      expect(text).toContain(",Société Générale,");
      expect(rows.find((row) => row[2] === symbolOf("B"))?.[3]).toBe(
        "'=Formula Corp, Inc.",
      );
    });

    it("exports a filter that matches nothing as a header alone", async () => {
      const { rows } = await exportCsv("?symbol=NOT-TRADED");
      expect(rows).toEqual([]);
    });

    /**
     * A file that stops early must never look finished. Before anything is sent a failed read is an
     * ordinary error response; once rows are on the wire the connection is cut instead, so the
     * download fails rather than ending quietly with part of the log.
     */
    describe("when the database fails mid-export", () => {
      /** The service's own client, swapped for one whose trade reads fail on a chosen call. */
      type ServiceWithClient = { prisma: PrismaService };

      afterEach(() => {
        (service as unknown as ServiceWithClient).prisma = prisma;
      });

      /**
       * Wraps the client the service reads through rather than spying on Prisma's model delegate:
       * the delegate is a proxy, and restoring a spy on it removes the method for the rest of the
       * suite.
       */
      function failOnRead(failingCall: number): void {
        let calls = 0;
        const trades = new Proxy(prisma.backtestTrade, {
          get(target, property, receiver) {
            if (property !== "findMany") {
              return Reflect.get(target, property, receiver) as unknown;
            }
            return (args: Parameters<typeof target.findMany>[0]) => {
              calls += 1;
              return calls === failingCall
                ? Promise.reject(new Error("connection lost"))
                : target.findMany(args);
            };
          },
        });
        (service as unknown as ServiceWithClient).prisma = new Proxy(prisma, {
          get(target, property, receiver) {
            return property === "backtestTrade"
              ? trades
              : (Reflect.get(target, property, receiver) as unknown);
          },
        });
      }

      it("answers an error, not an empty file, when the first read fails", async () => {
        failOnRead(1);
        const response = await owner
          .get(`/backtests/${runId}/trades/export`)
          .expect(500);
        expect(response.headers["content-type"]).toMatch(/^application\/json/);
        expect(response.headers["content-disposition"]).not.toMatch(
          /attachment/,
        );
      });

      it("cuts the connection when a later read fails, so no truncated file is delivered", async () => {
        failOnRead(2);
        // A plain Node request rather than supertest, so what the client observes is the socket's
        // own account of the response: complete, or cut off.
        const login = await request(app.getHttpServer())
          .post("/auth/login")
          .send({ email: ownerEmail, password })
          .expect(200);
        const cookie = (login.headers["set-cookie"] as unknown as string[])
          .map((header) => header.split(";")[0])
          .join("; ");
        const { port } = (
          app.getHttpServer() as { address(): AddressInfo }
        ).address();
        const outcome = await new Promise<{
          status: number | undefined;
          ending: "complete" | "cut off";
          bytes: number;
        }>((resolve) => {
          const outgoing = httpGet(
            {
              host: "127.0.0.1",
              port,
              path: `/backtests/${runId}/trades/export`,
              headers: { cookie },
            },
            (incoming) => {
              let bytes = 0;
              let settled = false;
              const settle = (ending: "complete" | "cut off") => {
                if (!settled) {
                  settled = true;
                  resolve({ status: incoming.statusCode, ending, bytes });
                }
              };
              incoming.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
              });
              incoming.on("aborted", () => settle("cut off"));
              incoming.on("error", () => settle("cut off"));
              incoming.on("end", () =>
                settle(incoming.complete ? "complete" : "cut off"),
              );
            },
          );
          outgoing.on("error", () =>
            resolve({ status: undefined, ending: "cut off", bytes: 0 }),
          );
        });
        // The first batch was already on the wire under a 200, and the client still sees a failure.
        expect(outcome.status).toBe(200);
        expect(outcome.bytes).toBeGreaterThan(0);
        expect(outcome.ending).toBe("cut off");
      });
    });
  });

  /**
   * A finished run's log never changes, so what every page repeats is read once. Each case changes
   * the stored rows behind the API's back — something no finished run ever sees — so only a fresh
   * read could notice, then restores them.
   */
  describe("repeated reads", () => {
    const extraSequence = TRADE_COUNT + 1;
    const extraSymbol = `ZZ${shortSuffix}`;

    async function addTrade(): Promise<void> {
      const trade = await prisma.backtestTrade.findFirstOrThrow({
        where: { runId },
        orderBy: { sequence: "asc" },
      });
      await prisma.backtestTrade.create({
        data: {
          ...trade,
          id: undefined,
          sequence: extraSequence,
          symbol: extraSymbol,
        },
      });
    }

    async function removeTrade(): Promise<void> {
      await prisma.backtestTrade.deleteMany({
        where: { runId, sequence: extraSequence },
      });
    }

    it("reads a finished run's symbols and trade count once, until it finishes again", async () => {
      const { completedAt } = await prisma.backtestRun.findUniqueOrThrow({
        where: { id: runId },
        select: { completedAt: true },
      });
      await page("");
      await addTrade();
      try {
        const cached = await page("");
        expect(cached.totalCount).toBe(TRADE_COUNT);
        expect(cached.symbols).not.toContain(extraSymbol);
        const filtered = await page(`?symbol=${symbolOf("A")}`);
        expect(filtered.unfilteredCount).toBe(TRADE_COUNT);

        // A retried run completes again, and its log is read again.
        await prisma.backtestRun.update({
          where: { id: runId },
          data: { completedAt: new Date() },
        });
        const reread = await page("");
        expect(reread.totalCount).toBe(TRADE_COUNT + 1);
        expect(reread.symbols).toContain(extraSymbol);
      } finally {
        await removeTrade();
        await prisma.backtestRun.update({
          where: { id: runId },
          data: { completedAt },
        });
      }
      const restored = await page("");
      expect(restored.totalCount).toBe(TRADE_COUNT);
      expect(restored.symbols).not.toContain(extraSymbol);
    });

    it("reads a run's log afresh on every page while it can still grow", async () => {
      const { completedAt } = await prisma.backtestRun.findUniqueOrThrow({
        where: { id: runId },
        select: { completedAt: true },
      });
      await prisma.backtestRun.update({
        where: { id: runId },
        data: { status: "RUNNING", completedAt: null },
      });
      try {
        expect((await page("")).totalCount).toBe(TRADE_COUNT);
        await addTrade();
        const grown = await page("");
        expect(grown.totalCount).toBe(TRADE_COUNT + 1);
        expect(grown.symbols).toContain(extraSymbol);
        expect((await page(`?symbol=${symbolOf("A")}`)).unfilteredCount).toBe(
          TRADE_COUNT + 1,
        );
      } finally {
        await removeTrade();
        await prisma.backtestRun.update({
          where: { id: runId },
          data: { status: "COMPLETED", completedAt },
        });
      }
      expect((await page("")).totalCount).toBe(TRADE_COUNT);
    });

    it("describes the run's trade reasons from its snapshot once, for pages and exports alike", async () => {
      const before = await page("?order=asc&pageSize=10");
      const { snapshot } = await prisma.backtestRun.findUniqueOrThrow({
        where: { id: runId },
        select: { snapshot: true },
      });
      // A snapshot no read could describe: only reasons already described can answer now.
      await prisma.backtestRun.update({
        where: { id: runId },
        data: { snapshot: {} },
      });
      try {
        const after = await page("?order=asc&pageSize=10");
        expect(after.items.map((trade) => trade.reason)).toEqual(
          before.items.map((trade) => trade.reason),
        );
        expect(after.items.some((trade) => trade.reason !== null)).toBe(true);
        const { rows } = await exportCsv();
        expect(rows).toHaveLength(TRADE_COUNT);
      } finally {
        await prisma.backtestRun.update({
          where: { id: runId },
          data: { snapshot: snapshot ?? {} },
        });
      }
    });
  });

  describe("ownership", () => {
    it("answers another user's run exactly like a missing one, on both routes", async () => {
      await other.get(`/backtests/${runId}/trades`).expect(404);
      await other.get(`/backtests/${runId}/trades/export`).expect(404);
      await owner.get(`/backtests/${randomUUID()}/trades/export`).expect(404);
    });

    it("requires a session", async () => {
      const anonymous = request(app.getHttpServer());
      await anonymous.get(`/backtests/${runId}/trades`).expect(401);
      await anonymous.get(`/backtests/${runId}/trades/export`).expect(401);
    });
  });
});
