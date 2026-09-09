import { createHash } from "node:crypto";
import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import {
  EXECUTION_CALENDAR_REFERENCE_CODE,
  normalizeBuyWindowConfiguration,
} from "@intrinsic/domain";
import {
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_SECURITIES,
  QA_MATRIX_STRATEGIES,
  type QaMatrixFixtures,
  type QaMatrixListFixture,
} from "@intrinsic/testing";
import { normalizeEmail } from "../auth/email";
import {
  assertQaSecuritySeedingAllowed,
  qaSeedDatabaseUrl,
} from "../stocks/seed-qa-securities";

/**
 * Seeds the persistent QA-MATRIX Strategy and Stock List fixtures for the Backtest V1 validation
 * matrix.
 *
 * The canonical definitions live in `@intrinsic/testing` (`qa-matrix/`); this module is only the
 * reconciliation between those definitions and the rows of one QA-owned account. It is
 * deterministic — no generated identifier carries meaning — and convergent: a second run against an
 * already-seeded database writes nothing at all, and a run against a drifted one restores the exact
 * fixture state, including removing members and whole fixtures that are no longer defined.
 *
 * **It creates no `BacktestRun`.** Seeding provisions the reusable inputs; executing the thousand
 * combinations is separate, backend-level work.
 *
 * Scope guarantees, which the suites in this directory pin:
 *
 * - every read and write is filtered by the resolved QA owner's `userId`, so no other user's
 *   strategies or lists can be read, updated or deleted, even one whose rows carry the same names;
 * - every delete is additionally filtered by the reserved `QA-MATRIX-` name prefix, so the QA
 *   persona's own ordinary fixtures are untouched;
 * - the connection target is `TEST_DATABASE_URL`, resolved explicitly rather than inherited.
 */

export const MISSING_EXECUTION_CALENDAR_MESSAGE =
  "Refusing to seed QA matrix fixtures: the pinned execution-calendar series has no bars in this " +
  "database. The matrix's buy-window boundaries name real execution dates, and the only authority " +
  "on which dates those are is the series a run pins at submission — so there is nothing to cut " +
  "them against. Hydrate the `" +
  EXECUTION_CALENDAR_REFERENCE_CODE +
  "` benchmark first.";

export const MISSING_QA_MATRIX_OWNER_MESSAGE =
  "Refusing to seed QA matrix fixtures: the QA_USER persona does not exist in the test database. " +
  "The matrix fixtures are owned by that account rather than by a generated one, so run " +
  "`pnpm test:users:seed` first.";

/** Reserved namespaces. A delete is only ever issued against rows matching one of these. */
const STRATEGY_NAME_PREFIX = `${QA_MATRIX_NAME_PREFIX}S`;
const LIST_NAME_PREFIX = `${QA_MATRIX_NAME_PREFIX}L`;

/**
 * Where matrix fixtures may be written, and where they may not.
 *
 * One rule with one implementation: these are the same kind of deterministic QA data
 * `pnpm test:securities:seed` writes — never production, never the development database, and only
 * ever the dedicated test database. Restating the rule here would be a second place for it to drift.
 */
export function assertQaMatrixSeedingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertQaSecuritySeedingAllowed(env);
}

export { qaSeedDatabaseUrl as qaMatrixSeedDatabaseUrl };

export type QaMatrixSeedResult = {
  readonly ownerUserId: string;
  /** The clock the persisted state corresponds to. */
  readonly asOfDate: string;
  /** The authoritative execution calendar the boundary fixtures were cut against. */
  readonly executionCalendar: {
    readonly dates: number;
    readonly from: string;
    readonly to: string;
  };
  readonly securitiesCreated: number;
  readonly strategiesCreated: number;
  readonly strategiesUpdated: number;
  readonly listsCreated: number;
  readonly listsUpdated: number;
  readonly staleRemoved: number;
};

function definitionHashOf(definition: StrategyDefinition): string {
  return createHash("sha256")
    .update(strategyDefinitionFingerprint(definition))
    .digest("hex");
}

function toDatabaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The authoritative execution dates, read from the pinned execution-calendar series.
 *
 * This is the **same** query the worker's `loadExecutionCalendar` makes — the current version of the
 * `EXECUTION_CALENDAR_REFERENCE_CODE` benchmark, its `BenchmarkDailyPrice` rows, ascending — and it
 * returns them in the same `readonly LocalDate[]` shape the simulation consumes. The matrix cuts its
 * boundaries against exactly the dates the runs will execute on, and holds no second opinion about
 * which days those are.
 *
 * A run pins the **highest** series version at submission, so that is the version read here.
 */
export async function loadQaMatrixExecutionCalendar(
  prisma: PrismaClient,
): Promise<string[]> {
  const series = (
    await prisma.benchmark.findFirst({
      where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    })
  )?.series[0];
  if (!series) {
    throw new Error(MISSING_EXECUTION_CALENDAR_MESSAGE);
  }
  const bars = await prisma.benchmarkDailyPrice.findMany({
    where: { seriesId: series.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  if (bars.length === 0) {
    throw new Error(MISSING_EXECUTION_CALENDAR_MESSAGE);
  }
  return bars.map((bar) => fromDatabaseDate(bar.date));
}

/**
 * The QA persona that owns every matrix fixture.
 *
 * Resolved, never created: persona credentials and roles belong to `pnpm test:users:seed`, and a
 * matrix seed that quietly created a passwordless account with the persona's address would make
 * that seeder's guarantees untrue.
 */
export async function resolveQaMatrixOwner(
  prisma: PrismaClient,
  email: string,
): Promise<string> {
  const owner = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true },
  });
  if (!owner) {
    throw new Error(MISSING_QA_MATRIX_OWNER_MESSAGE);
  }
  return owner.id;
}

/**
 * Ensures the catalog carries every security the matrix lists reference.
 *
 * These are real catalog identities, and the catalog is the identity authority: an existing row is
 * therefore left exactly as it is, whether it came from a real synchronization or from an earlier
 * seed. Only a missing row is created, and only with identity — no prices, no derived state, no
 * fundamentals. The market data a future matrix *run* needs is hydrated by the normal loader, not
 * invented here.
 */
async function seedMatrixSecurities(
  prisma: PrismaClient,
): Promise<{ idBySymbol: Map<string, string>; created: number }> {
  const idBySymbol = new Map<string, string>();
  let created = 0;

  for (const security of QA_MATRIX_SECURITIES) {
    const existing = await prisma.security.findFirst({
      where: { symbol: security.symbol, exchangeCode: security.exchangeCode },
      select: { id: true },
    });
    if (existing) {
      idBySymbol.set(security.symbol, existing.id);
      continue;
    }
    const row = await prisma.security.create({
      data: {
        providerSymbol: security.symbol,
        symbol: security.symbol,
        name: security.name,
        exchangeCode: security.exchangeCode,
        exchangeName: security.exchangeName,
        currency: security.currency,
        type: security.type,
        isAdr: security.isAdr,
        isActivelyTrading: security.isActivelyTrading,
        ipoDate: toDatabaseDate(security.listedOn),
      },
      select: { id: true },
    });
    idBySymbol.set(security.symbol, row.id);
    created += 1;
  }

  return { idBySymbol, created };
}

/**
 * Reduces the owner's rows in one reserved namespace to at most one row per defined fixture name.
 *
 * Two things are removed: a fixture that no longer exists — a renamed or retired one — and every
 * duplicate beyond the first of a name that does. "First" is the oldest by `createdAt`, with the id
 * breaking a same-tick tie, so which row survives never depends on scan order. Deleting a Strategy
 * or a StockList nulls the foreign keys of any backtest run that used it and deletes no run, which
 * is exactly the reproducibility rule the schema encodes.
 */
async function pruneNamespace<Row extends { id: string; name: string }>(
  rows: readonly Row[],
  definedNames: ReadonlySet<string>,
  remove: (ids: readonly string[]) => Promise<unknown>,
): Promise<{ survivors: Map<string, Row>; removed: number }> {
  const survivors = new Map<string, Row>();
  const doomed: string[] = [];

  for (const row of rows) {
    if (!definedNames.has(row.name) || survivors.has(row.name)) {
      doomed.push(row.id);
      continue;
    }
    survivors.set(row.name, row);
  }

  if (doomed.length > 0) {
    await remove(doomed);
  }
  return { survivors, removed: doomed.length };
}

async function seedMatrixStrategies(
  prisma: PrismaClient,
  userId: string,
): Promise<{ created: number; updated: number; removed: number }> {
  const rows = await prisma.strategy.findMany({
    where: { userId, name: { startsWith: STRATEGY_NAME_PREFIX } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
  });

  const { survivors, removed } = await pruneNamespace(
    rows,
    new Set(QA_MATRIX_STRATEGIES.map((fixture) => fixture.name)),
    (ids) =>
      prisma.strategy.deleteMany({
        // Ownership and namespace are re-asserted on the delete itself, not only on the read that
        // produced the ids, so a concurrent change cannot widen what this statement removes.
        where: {
          id: { in: [...ids] },
          userId,
          name: { startsWith: STRATEGY_NAME_PREFIX },
        },
      }),
  );

  let created = 0;
  let updated = 0;

  for (const fixture of QA_MATRIX_STRATEGIES) {
    // The canonical normalizer, so a fixture is persisted through exactly the path a saved
    // strategy takes and an invalid one fails here rather than reaching the Builder.
    const definition = normalizeStrategyDefinition(fixture.definition);
    const hash = definitionHashOf(definition);
    const existing = survivors.get(fixture.name);

    if (!existing) {
      await prisma.strategy.create({
        data: {
          userId,
          name: fixture.name,
          description: fixture.description,
          versions: {
            create: {
              versionNumber: 1,
              definition: definition as unknown as Prisma.InputJsonValue,
              definitionHash: hash,
            },
          },
        },
      });
      created += 1;
      continue;
    }

    const current = existing.versions[0];
    const definitionChanged = current?.definitionHash !== hash;
    const descriptionChanged = existing.description !== fixture.description;
    if (!definitionChanged && !descriptionChanged) {
      // Writing identical values would still move `updatedAt`, which is the one observable a
      // "second seed changes nothing" assertion can be made against.
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (definitionChanged) {
        // Versions are append-only: an existing row is never rewritten, because a completed run
        // may reference it.
        await tx.strategyVersion.create({
          data: {
            strategyId: existing.id,
            versionNumber: (current?.versionNumber ?? 0) + 1,
            definition: definition as unknown as Prisma.InputJsonValue,
            definitionHash: hash,
          },
        });
      }
      await tx.strategy.updateMany({
        where: { id: existing.id, userId },
        data: { description: fixture.description },
      });
    });
    updated += 1;
  }

  return { created, updated, removed };
}

/** The canonical persisted window set of one fixture member, as `YYYY-MM-DD` pairs. */
function canonicalRanges(
  member: QaMatrixListFixture["members"][number],
): { startDate: string; endDate: string | null }[] {
  return normalizeBuyWindowConfiguration({
    mode: member.mode,
    ranges: member.ranges,
  }).ranges.map((range) => ({
    startDate: range.startDate,
    endDate: range.endDate,
  }));
}

function sameRanges(
  left: readonly { startDate: string; endDate: string | null }[],
  right: readonly { startDate: string; endDate: string | null }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.startDate === right[index]?.startDate &&
        range.endDate === right[index]?.endDate,
    )
  );
}

async function seedMatrixLists(
  prisma: PrismaClient,
  userId: string,
  idBySymbol: ReadonlyMap<string, string>,
  lists: readonly QaMatrixListFixture[],
): Promise<{ created: number; updated: number; removed: number }> {
  const rows = await prisma.stockList.findMany({
    where: { userId, name: { startsWith: LIST_NAME_PREFIX } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      items: { include: { buyWindows: { orderBy: { startDate: "asc" } } } },
    },
  });

  const { survivors, removed } = await pruneNamespace(
    rows,
    new Set(lists.map((fixture) => fixture.name)),
    (ids) =>
      prisma.stockList.deleteMany({
        where: {
          id: { in: [...ids] },
          userId,
          name: { startsWith: LIST_NAME_PREFIX },
        },
      }),
  );

  let created = 0;
  let updated = 0;

  for (const fixture of lists) {
    const wanted = fixture.members.map((member) => {
      const securityId = idBySymbol.get(member.symbol);
      if (!securityId) {
        throw new Error(
          `\`${member.symbol}\` is referenced by ${fixture.name} but is not in the catalog`,
        );
      }
      return { member, securityId, ranges: canonicalRanges(member) };
    });

    const existing = survivors.get(fixture.name);
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        const list = await tx.stockList.create({
          data: {
            userId,
            name: fixture.name,
            description: fixture.description,
          },
          select: { id: true },
        });
        for (const entry of wanted) {
          const item = await tx.stockListItem.create({
            data: {
              stockListId: list.id,
              securityId: entry.securityId,
              buyWindowMode: entry.member.mode,
            },
            select: { id: true },
          });
          if (entry.ranges.length > 0) {
            await tx.stockListBuyWindow.createMany({
              data: entry.ranges.map((range) => ({
                stockListItemId: item.id,
                startDate: toDatabaseDate(range.startDate),
                endDate:
                  range.endDate === null ? null : toDatabaseDate(range.endDate),
              })),
            });
          }
        }
      });
      created += 1;
      continue;
    }

    const wantedSecurityIds = new Set(wanted.map((entry) => entry.securityId));
    const itemBySecurityId = new Map(
      existing.items.map((item) => [item.securityId, item]),
    );
    const staleItems = existing.items.filter(
      (item) => !wantedSecurityIds.has(item.securityId),
    );
    const descriptionChanged = existing.description !== fixture.description;
    const changedEntries = wanted.filter((entry) => {
      const item = itemBySecurityId.get(entry.securityId);
      if (!item) {
        return true;
      }
      return (
        item.buyWindowMode !== entry.member.mode ||
        !sameRanges(
          item.buyWindows.map((window) => ({
            startDate: fromDatabaseDate(window.startDate),
            endDate:
              window.endDate === null ? null : fromDatabaseDate(window.endDate),
          })),
          entry.ranges,
        )
      );
    });

    if (
      !descriptionChanged &&
      staleItems.length === 0 &&
      changedEntries.length === 0
    ) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (descriptionChanged) {
        await tx.stockList.updateMany({
          where: { id: existing.id, userId },
          data: { description: fixture.description },
        });
      }
      if (staleItems.length > 0) {
        // A member the fixture no longer defines is removed outright; its windows cascade.
        await tx.stockListItem.deleteMany({
          where: {
            stockListId: existing.id,
            id: { in: staleItems.map((item) => item.id) },
          },
        });
      }
      for (const entry of changedEntries) {
        const item = itemBySecurityId.get(entry.securityId);
        const itemId = item
          ? (
              await tx.stockListItem.update({
                where: { id: item.id },
                data: { buyWindowMode: entry.member.mode },
                select: { id: true },
              })
            ).id
          : (
              await tx.stockListItem.create({
                data: {
                  stockListId: existing.id,
                  securityId: entry.securityId,
                  buyWindowMode: entry.member.mode,
                },
                select: { id: true },
              })
            ).id;
        // Windows are replaced as a complete set, exactly as the API's own replace endpoint does;
        // FULL therefore ends with zero rows.
        await tx.stockListBuyWindow.deleteMany({
          where: { stockListItemId: itemId },
        });
        if (entry.ranges.length > 0) {
          await tx.stockListBuyWindow.createMany({
            data: entry.ranges.map((range) => ({
              stockListItemId: itemId,
              startDate: toDatabaseDate(range.startDate),
              endDate:
                range.endDate === null ? null : toDatabaseDate(range.endDate),
            })),
          });
        }
      }
    });
    updated += 1;
  }

  return { created, updated, removed };
}

/**
 * Reconciles the complete matrix fixture set for one owner, at one clock.
 *
 * `ownerUserId` is passed in rather than resolved here so the integration suites can exercise the
 * real reconciliation against an isolated randomized user, exactly as every other DB-backed suite
 * does, instead of depending on the persistent persona.
 *
 * `fixtures` carries the clock. Seeding twice **with the same clock** writes nothing the second
 * time; seeding with a later one legitimately updates the boundary list, whose windows are cut
 * against that clock's trading sessions. A sweep pins one clock across seeding, execution and
 * reporting.
 */
export async function seedQaMatrixFixtures(
  prisma: PrismaClient,
  ownerUserId: string,
  fixtures: QaMatrixFixtures,
): Promise<QaMatrixSeedResult> {
  // Guarded here as well as at the entry point, so no caller can reach the writes without it.
  assertQaMatrixSeedingAllowed();

  const securities = await seedMatrixSecurities(prisma);
  const strategies = await seedMatrixStrategies(prisma, ownerUserId);
  const lists = await seedMatrixLists(
    prisma,
    ownerUserId,
    securities.idBySymbol,
    fixtures.lists,
  );

  return {
    ownerUserId,
    asOfDate: fixtures.periods.asOfDate,
    executionCalendar: {
      dates: fixtures.calendar.length,
      from: fixtures.calendar.first ?? "",
      to: fixtures.calendar.last ?? "",
    },
    securitiesCreated: securities.created,
    strategiesCreated: strategies.created,
    strategiesUpdated: strategies.updated,
    listsCreated: lists.created,
    listsUpdated: lists.updated,
    staleRemoved: strategies.removed + lists.removed,
  };
}

/** What the seed reports; also the shape the documentation's expected output is written from. */
export function describeQaMatrixSeed(
  result: QaMatrixSeedResult,
  fixtures: QaMatrixFixtures,
): string {
  return [
    `as of ${result.asOfDate}`,
    `execution calendar ${result.executionCalendar.dates} dates ` +
      `(${result.executionCalendar.from} to ${result.executionCalendar.to})`,
    `${fixtures.strategies.length} strategies (${result.strategiesCreated} created, ${result.strategiesUpdated} updated)`,
    `${fixtures.lists.length} lists (${result.listsCreated} created, ${result.listsUpdated} updated)`,
    `${QA_MATRIX_SECURITIES.length} securities (${result.securitiesCreated} created)`,
    `${result.staleRemoved} stale fixture(s) removed`,
    `${fixtures.strategies.length * fixtures.lists.length * fixtures.configs.length} combinations available`,
  ].join(", ");
}
