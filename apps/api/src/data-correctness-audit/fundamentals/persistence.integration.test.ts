import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DailyDerivedState,
  FinancialStatementDraft,
} from "@intrinsic/domain";
import {
  CanonicalStockDataService,
  InMemoryLoadCoordinator,
  NullStockDataCache,
  PrismaStockDataStore,
  fundamentalsDatasetOperations,
  priceRetentionYears,
  subtractYears,
} from "@intrinsic/stock-data";
import {
  FUNDAMENTAL_AUDIT_ANCHOR_SYNCS,
  FUNDAMENTAL_AUDIT_METRICS,
  fundamentalAuditAnchorSessions,
  useTestDatabase,
} from "@intrinsic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaFloatBoundAtScale } from "../oracle/decimal";

loadRootEnv();
useTestDatabase();

/**
 * `DailyDerivedState` persistence of the fifteen metrics (audit section 13).
 *
 * The write path binds a JS number, which Prisma renders with sixteen significant digits, and
 * PostgreSQL rounds that to the column's eight decimals, half away from zero — measured on this
 * branch against the live column (every probe value matched that model; only two thirds matched a
 * single correct rounding of the double). `prismaFloatBoundAtScale`, the audit oracle's own model
 * of that binding, states the expected text; a few boundaries are pinned literally as well. Every
 * layer reads the stored decimal, so this is the value every consumer agrees on.
 */
describe("the fifteen Fundamental columns in PostgreSQL", () => {
  let prisma: PrismaClient;
  let store: PrismaStockDataStore;
  const created: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
    store = new PrismaStockDataStore(prisma);
  });

  afterAll(async () => {
    await prisma.security.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function security(
    name: string,
  ): Promise<{ id: string; symbol: string }> {
    const symbol = `PS${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name,
        exchangeCode: "NYSE",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    created.push(row.id);
    return { id: row.id, symbol };
  }

  async function storedText(securityId: string) {
    const columns = FUNDAMENTAL_AUDIT_METRICS.map(
      (metric) => `"${metric.field}"::text as "${metric.field}"`,
    );
    return prisma.$queryRawUnsafe<
      ({ date: string } & Record<string, string | null>)[]
    >(
      `select date::text as date, ${columns.join(", ")} from "DailyDerivedState" where "securityId" = $1 order by date`,
      securityId,
    );
  }

  it("stores each value at the binding model's text, positive, zero, negative and at the half-quantum boundaries", async () => {
    const { id } = await security("Quantization Audit");
    const values = [
      0.123456785,
      1.000000005,
      -2.500000005,
      12.345678905,
      999_999_999_999.9998,
      -999_999_999_999.9998,
      5e-9,
      4.9e-9,
      0,
      -4.9e-9,
      1e-12,
      0.1 + 0.2,
      15.42,
      -0.75,
      123_456_789.12345679,
    ];
    const dates = values.map(
      (_value, index) => `2025-01-${String(index + 2).padStart(2, "0")}`,
    );
    const rows: DailyDerivedState[] = dates.map((date, index) => {
      const row: Record<string, unknown> = { securityId: id, date };
      // Each metric gets the value rotated by its position, so every column sees every value.
      FUNDAMENTAL_AUDIT_METRICS.forEach((metric, metricIndex) => {
        row[metric.field] = values[(index + metricIndex) % values.length];
      });
      return row as DailyDerivedState;
    });
    await store.saveDailyDerivedState({
      securityId: id,
      rows,
      weeklyPrices: [],
      successfulCoverage: { from: dates[0]!, to: dates.at(-1)! },
      syncedAt: new Date().toISOString(),
    });
    const stored = await storedText(id);
    const readBack = await store.getDailyDerivedState(id, {
      from: dates[0]!,
      to: dates.at(-1)!,
    });
    stored.forEach((row, index) => {
      FUNDAMENTAL_AUDIT_METRICS.forEach((metric, metricIndex) => {
        const value = values[(index + metricIndex) % values.length]!;
        const expected = prismaFloatBoundAtScale(value, 8).replace(
          /^-0\.00000000$/,
          "0.00000000",
        );
        expect(row[metric.field], `${metric.id} <- ${value}`).toBe(expected);
        // What every consumer then reads: the stored decimal as a number, never absent, never -0.
        const read = (readBack[index] as unknown as Record<string, number>)[
          metric.field
        ];
        expect(
          Object.is(read, Number(expected)) ||
            (Number(expected) === 0 && read === 0),
          `${metric.id} read ${read}`,
        ).toBe(true);
      });
    });
    // Pinned literally: the half-quantum cases round away from zero on the sixteen-digit text.
    expect(prismaFloatBoundAtScale(0.123456785, 8)).toBe("0.12345679");
    expect(prismaFloatBoundAtScale(999_999_999_999.9998, 8)).toBe(
      "999999999999.99980000",
    );
    expect(prismaFloatBoundAtScale(5e-9, 8)).toBe("0.00000001");
    expect(prismaFloatBoundAtScale(4.9e-9, 8)).toBe("0.00000000");
  });

  it("keeps an absent metric NULL and absent on read, beside present siblings", async () => {
    const { id } = await security("Absence Audit");
    const row: Record<string, unknown> = { securityId: id, date: "2025-02-03" };
    FUNDAMENTAL_AUDIT_METRICS.forEach((metric, index) => {
      if (index % 2 === 0) {
        row[metric.field] = index - 7;
      }
    });
    await store.saveDailyDerivedState({
      securityId: id,
      rows: [row as DailyDerivedState],
      weeklyPrices: [],
      successfulCoverage: { from: "2025-02-03", to: "2025-02-03" },
      syncedAt: new Date().toISOString(),
    });
    const [stored] = await storedText(id);
    const [read] = await store.getDailyDerivedState(id, {
      from: "2025-02-03",
      to: "2025-02-03",
    });
    FUNDAMENTAL_AUDIT_METRICS.forEach((metric, index) => {
      if (index % 2 === 0) {
        expect(stored![metric.field]).toBe(`${index - 7}.00000000`);
        expect((read as unknown as Record<string, number>)[metric.field]).toBe(
          index - 7,
        );
      } else {
        expect(stored![metric.field]).toBeNull();
        expect(metric.field in (read as object)).toBe(false);
      }
    });
  });

  it("leaves every other derived column exactly as it is without statements", async () => {
    // Two securities with the same prices; one carries the anchor's statements. Technicals, weekly
    // values, RSI and RVOL must be identical row for row; the Fundamental columns are the difference.
    const sessions = fundamentalAuditAnchorSessions();
    const today = new Date().toISOString().slice(0, 10);
    const syncedAt = new Date().toISOString();
    const withStatements = await security("Isolation With Statements");
    const without = await security("Isolation Without Statements");
    for (const target of [withStatements, without]) {
      await store.saveDailyPriceSync({
        securityId: target.id,
        prices: sessions.map((date, index) => {
          const close = 40 + (index % 31) * 0.53 + index * 0.02;
          return {
            securityId: target.id,
            date,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 5_000 + (index % 9) * 250,
          };
        }),
        successfulCoverage: [
          { from: subtractYears(today, priceRetentionYears(30)), to: today },
        ],
        syncedAt,
        tailDate: today,
        freshThrough: today,
      });
      // Verified under the current loader, so no first verification re-reads the history.
      await store.createPriceBasis({
        securityId: target.id,
        verifiedAt: syncedAt,
      });
      for (const operation of fundamentalsDatasetOperations(30)) {
        await store.upsertDatasetState({
          securityId: target.id,
          dataset: operation.dataset,
          variant: operation.variant,
          syncedAt,
        });
      }
      await store.upsertDatasetState({
        securityId: target.id,
        dataset: "SECURITY_PROFILE",
        variant: "",
        syncedAt,
      });
    }
    for (const sync of FUNDAMENTAL_AUDIT_ANCHOR_SYNCS) {
      await store.saveFinancialStatements({
        securityId: withStatements.id,
        statements: sync.statements.map(
          (draft) =>
            ({
              ...draft,
              securityId: withStatements.id,
            }) as FinancialStatementDraft,
        ),
        syncedAt: sync.observedAt,
      });
    }
    const provider = {
      getProfile: async () => {
        throw new Error("no provider");
      },
      getDailyPrices: async () => {
        throw new Error("no provider");
      },
      getFinancialStatements: async () => {
        throw new Error("no provider");
      },
    };
    const service = new CanonicalStockDataService(
      store,
      provider,
      new NullStockDataCache(),
      new InMemoryLoadCoordinator(),
      { productHistoryYears: 30 },
    );
    const range = { from: sessions[0]!, to: sessions.at(-1)! };
    await service.getDailyDerivedState(withStatements.symbol, range);
    await service.getDailyDerivedState(without.symbol, range);
    const fundamentals = new Set<string>(
      FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.field),
    );
    const everyColumn = async (securityId: string) =>
      prisma.$queryRawUnsafe<{ date: string; row: Record<string, unknown> }[]>(
        `select date::text as date, to_jsonb(d) - 'securityId' as row from "DailyDerivedState" d where "securityId" = $1 order by date`,
        securityId,
      );
    const left = await everyColumn(withStatements.id);
    const right = await everyColumn(without.id);
    expect(left.map((row) => row.date)).toEqual(right.map((row) => row.date));
    const intrinsic = [
      "dcfFcff",
      "residualIncome",
      "ddm",
      "graham",
      "blendBalanced",
      "blendConservative",
      "blendDividend",
      "dcfFcffSourceAsOf",
      "residualIncomeSourceAsOf",
      "ddmSourceAsOf",
      "grahamSourceAsOf",
      "intrinsicCurrency",
    ];
    let populated = 0;
    left.forEach((row, index) => {
      const other = right[index]!.row;
      for (const [column, value] of Object.entries(row.row)) {
        if (fundamentals.has(column)) {
          expect(
            other[column],
            `${row.date} ${column} without statements`,
          ).toBeNull();
          if (value !== null) {
            populated += 1;
          }
        } else if (!intrinsic.includes(column)) {
          expect(value, `${row.date} ${column}`).toEqual(other[column]);
        }
      }
    });
    expect(populated).toBeGreaterThan(sessions.length * 12);
  }, 120_000);
});
