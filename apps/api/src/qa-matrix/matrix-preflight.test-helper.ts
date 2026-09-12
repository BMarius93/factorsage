import { readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeStrategyDefinition } from "@intrinsic/contracts";
import type { PrismaClient } from "@intrinsic/database";
import {
  DAILY_DERIVED_STATE_VARIANT,
  DAILY_PRICE_VARIANT_FAMILY,
  PRICE_DATASET_VERSION,
} from "@intrinsic/stock-data";
import {
  QA_MATRIX_SECURITIES,
  type QaMatrixFixtures,
} from "@intrinsic/testing";
import { repositoryRoot } from "./matrix-paths";
import type { MatrixEnvironment } from "./matrix-environment";

/**
 * A database that satisfies every preflight check, and the knobs to break one at a time.
 *
 * The preflight's whole job is to refuse an environment that would produce a plausible-looking but
 * wrong sweep. Proving that means presenting it with each broken environment in turn, which is far
 * more precise from a stub than from a real database somebody would have to damage first.
 */

export type StubOptions = {
  /** Execution-calendar dates. Default: enough to cover a thirty-year matrix. */
  calendarDates?: readonly string[];
  /** Omit the QA persona. */
  noOwner?: boolean;
  /** The owner's persisted commercial plan. Default: `PRO`. */
  ownerPlan?: "FREE" | "STARTER" | "PRO";
  /** The owner's persisted role. Default: `ADMIN`, which is what the matrix expects. */
  ownerRole?: "USER" | "ADMIN";
  /** Drop these strategy fixture ids from the database. */
  missingStrategies?: readonly string[];
  /** Drop these list fixture ids. */
  missingLists?: readonly string[];
  /** Corrupt the stored definition of this strategy fixture id. */
  driftedStrategy?: string;
  /** Symbols with no `Security` row. */
  missingSymbols?: readonly string[];
  /** Symbols whose prices start here instead of covering the horizon. */
  latePrices?: Readonly<Record<string, string>>;
  /** Symbols with no derived state. */
  noDerivedState?: readonly string[];
  /** Symbols with no financial statements. Default: none. */
  noStatements?: readonly string[];
  /** Persist a stale derived-state variant instead of the current one. */
  staleDerivedVariant?: boolean;
  /** Report these migrations as never applied. */
  unappliedMigrations?: readonly string[];
  /** Report a different connected database than the URL names. */
  connectedDatabase?: string;
};

export const MATRIX_ENVIRONMENT: MatrixEnvironment = {
  databaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value_matrix",
  databaseName: "intrinsic_value_matrix",
  host: "localhost",
  port: 5432,
  adminDatabaseUrl: "postgresql://u:p@localhost:5432/postgres",
  redisUrl: "redis://localhost:6379/3",
  redisDb: 3,
  sourceDatabaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value",
  developmentDatabaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value",
  developmentRedisUrl: "redis://localhost:6379",
  testDatabaseUrl: "postgresql://u:p@localhost:5432/intrinsic_value_test",
};

/** Every weekday from `from` to `to`, which is a superset of any real trading calendar. */
export function weekdays(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const asDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export function stubPrisma(
  fixtures: QaMatrixFixtures,
  options: StubOptions = {},
): PrismaClient {
  const calendarDates = options.calendarDates ?? fixtures.calendar.dates;
  const migrations = readdirSync(
    join(repositoryRoot(), "packages/database/prisma/migrations"),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const securityIdOf = (symbol: string): string => `sec-${symbol}`;
  const missingSymbols = new Set(options.missingSymbols ?? []);
  const noDerived = new Set(options.noDerivedState ?? []);
  const noStatements = new Set(options.noStatements ?? []);
  const firstPriceOf = (symbol: string): string => {
    const late = options.latePrices?.[symbol];
    if (late) {
      return late;
    }
    const fixture = QA_MATRIX_SECURITIES.find(
      (entry) => entry.symbol === symbol,
    );
    return fixture && fixture.coverage === "LATER_LISTING"
      ? fixture.listedOn
      : "1992-01-02";
  };
  const lastPrice = calendarDates[calendarDates.length - 1] ?? "2026-09-08";
  const symbolOfSecurityId = (id: string): string => id.replace(/^sec-/, "");

  const strategies = fixtures.strategies
    .filter(
      (fixture) => !(options.missingStrategies ?? []).includes(fixture.id),
    )
    .map((fixture) => ({
      id: `strategy-${fixture.id}`,
      name: fixture.name,
      versions: [
        {
          id: `version-${fixture.id}`,
          versionNumber: 1,
          definition:
            options.driftedStrategy === fixture.id
              ? normalizeStrategyDefinition({
                  ...fixture.definition,
                  buyLevels: fixture.definition.buyLevels.slice(0, 1),
                })
              : normalizeStrategyDefinition(fixture.definition),
        },
      ],
    }));

  const lists = fixtures.lists
    .filter((fixture) => !(options.missingLists ?? []).includes(fixture.id))
    .map((fixture) => ({
      id: `list-${fixture.id}`,
      name: fixture.name,
      items: fixture.members.map((member) => ({
        buyWindowMode: member.mode,
        security: { symbol: member.symbol, id: securityIdOf(member.symbol) },
        buyWindows: member.ranges.map((range) => ({
          startDate: asDate(range.startDate),
          endDate: range.endDate === null ? null : asDate(range.endDate),
        })),
      })),
    }));

  const stub = {
    async $queryRawUnsafe(sql: string): Promise<unknown[]> {
      if (sql.includes("current_database")) {
        return [
          {
            database:
              options.connectedDatabase ?? MATRIX_ENVIRONMENT.databaseName,
            server: "127.0.0.1",
          },
        ];
      }
      return migrations
        .filter((name) => !(options.unappliedMigrations ?? []).includes(name))
        .map((name) => ({
          migration_name: name,
          finished_at: new Date(),
          rolled_back_at: null,
        }));
    },
    user: {
      findFirst: async () =>
        options.noOwner
          ? null
          : {
              id: "qa-user",
              email: "qa-user@factorsage.test",
              // The matrix owner is an administrator: the sweep submits through the product's
              // real entitlement-enforced path at a concurrency no commercial plan sells.
              plan: options.ownerPlan ?? "PRO",
              role: options.ownerRole ?? "ADMIN",
            },
    },
    strategy: { findMany: async () => strategies },
    stockList: { findMany: async () => lists },
    stockListItem: { count: async () => 0 },
    benchmark: {
      findFirst: async () => ({
        id: "benchmark-1",
        code: "SP500",
        series: [{ id: "series-1", version: 1 }],
      }),
    },
    benchmarkDailyPrice: {
      findMany: async () =>
        calendarDates.map((date) => ({ date: asDate(date) })),
      aggregate: async () => ({
        _min: { date: calendarDates[0] ? asDate(calendarDates[0]) : null },
        _max: { date: asDate(lastPrice) },
        _count: calendarDates.length,
      }),
    },
    security: {
      findMany: async ({ where }: { where: { symbol: { in: string[] } } }) =>
        where.symbol.in
          .filter((symbol) => !missingSymbols.has(symbol))
          .map((symbol) => {
            const fixture = QA_MATRIX_SECURITIES.find(
              (e) => e.symbol === symbol,
            );
            return {
              id: securityIdOf(symbol),
              symbol,
              ipoDate: fixture ? asDate(fixture.listedOn) : null,
            };
          }),
    },
    dailyPrice: {
      aggregate: async ({ where }: { where: { securityId: string } }) => {
        const symbol = symbolOfSecurityId(where.securityId);
        return {
          _min: { date: asDate(firstPriceOf(symbol)) },
          _max: { date: asDate(lastPrice) },
          _count: 8000,
        };
      },
    },
    dailyDerivedState: {
      aggregate: async ({ where }: { where: { securityId: string } }) => {
        const symbol = symbolOfSecurityId(where.securityId);
        if (noDerived.has(symbol)) {
          return { _min: { date: null }, _max: { date: null }, _count: 0 };
        }
        return {
          _min: { date: asDate(firstPriceOf(symbol)) },
          _max: { date: asDate(lastPrice) },
          _count: 8000,
        };
      },
    },
    financialStatement: {
      count: async ({ where }: { where: { securityId: string } }) =>
        noStatements.has(symbolOfSecurityId(where.securityId)) ? 0 : 500,
    },
    stockDatasetState: {
      findMany: async ({
        where,
      }: {
        where: { securityId: { in: string[] } };
      }) =>
        where.securityId.in.flatMap((securityId) => [
          {
            securityId,
            dataset: "DAILY_PRICE",
            variant: `${DAILY_PRICE_VARIANT_FAMILY}:v${PRICE_DATASET_VERSION}`,
          },
          {
            securityId,
            dataset: "DAILY_DERIVED_STATE",
            variant: options.staleDerivedVariant
              ? "daily-derived-state:r1"
              : DAILY_DERIVED_STATE_VARIANT,
          },
        ]),
    },
  };
  return stub as unknown as PrismaClient;
}
