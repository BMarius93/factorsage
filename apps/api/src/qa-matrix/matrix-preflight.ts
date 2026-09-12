import { readdirSync } from "node:fs";
import { getStockDataConfig } from "@intrinsic/config";
import { join } from "node:path";
import {
  BACKTEST_MAX_PERIOD_YEARS,
  DEFAULT_BENCHMARK_CODE,
  findSelectableSeries,
  normalizeStrategyDefinition,
  resolveEntitlements,
  subtractYears,
  withinLimit,
  type SelectableSeriesId,
  type UserPlan,
  type UserRole,
} from "@intrinsic/contracts";
import type { PrismaClient } from "@intrinsic/database";
import { EXECUTION_CALENDAR_REFERENCE_CODE } from "@intrinsic/domain";
import {
  BACKTEST_DATA_REVISIONS,
  DAILY_DERIVED_STATE_VARIANT,
  DAILY_PRICE_VARIANT_FAMILY,
  PRICE_DATASET_VERSION,
} from "@intrinsic/stock-data";
import {
  collectOperands,
  ExecutionCalendar,
  PRICE_OPERAND,
} from "@intrinsic/strategy";
import {
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_CONFIGS,
  QA_MATRIX_EXPECTED_LISTS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_SECURITIES,
  type QaMatrixFixtures,
  type QaMatrixSecurity,
} from "@intrinsic/testing";
import { parseCreateBacktestRunRequest } from "../backtests/backtest-requests";
import { qaMatrixCases, QA_MATRIX_TOTAL_CASES } from "./matrix-case";
import type { MatrixEnvironment } from "./matrix-environment";

/**
 * The preflight for the Backtest V1 validation matrix.
 *
 * A thousand thirty-year runs take hours, and every failure mode this checks for produces a sweep
 * that *looks* successful: a calendar covering six of the thirty years requested, a security whose
 * price history starts after the run does, a derived-state revision the loader will silently
 * rebuild from the provider halfway through, nine strategies where there should be ten. None of
 * those raise an error at run time — they change the numbers and say nothing — so they are checked
 * once, up front, against the database the runs will actually execute in.
 *
 * Every check answers a question with evidence from that database rather than from a watermark. A
 * `StockDatasetCoverage` row claiming thirty years of prices is a claim; `min(DailyPrice.date)` is
 * the fact the day loop will read. Both are reported, because a disagreement between them is
 * itself a finding: it is exactly the state in which the loader decides to call the provider.
 *
 * **Nothing here writes.** The preflight is safe to run at any time, including against a sweep in
 * flight.
 */

export type PreflightStatus = "PASS" | "WARN" | "FAIL";

export type PreflightCheck = {
  readonly id: string;
  readonly title: string;
  readonly status: PreflightStatus;
  /** One line a human reads first. */
  readonly detail: string;
  /** Structured evidence, so a report is machine-readable as well as legible. */
  readonly facts?: Record<string, unknown>;
  /** Individual problems, capped for legibility with a count when truncated. */
  readonly problems?: readonly string[];
};

export type QaMatrixPreflightReport = {
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly asOfDate: string;
  readonly database: string;
  readonly redis: string;
  readonly checks: readonly PreflightCheck[];
  readonly failed: number;
  readonly warned: number;
};

const PROBLEM_LIST_CAP = 12;

function summarize(problems: readonly string[]): readonly string[] {
  if (problems.length <= PROBLEM_LIST_CAP) {
    return problems;
  }
  return [
    ...problems.slice(0, PROBLEM_LIST_CAP),
    `… and ${problems.length - PROBLEM_LIST_CAP} more`,
  ];
}

function check(
  id: string,
  title: string,
  problems: readonly string[],
  passDetail: string,
  facts?: Record<string, unknown>,
  severity: "FAIL" | "WARN" = "FAIL",
): PreflightCheck {
  if (problems.length === 0) {
    return {
      id,
      title,
      status: "PASS",
      detail: passDetail,
      ...(facts ? { facts } : {}),
    };
  }
  return {
    id,
    title,
    status: severity,
    detail: `${problems.length} problem${problems.length === 1 ? "" : "s"}`,
    ...(facts ? { facts } : {}),
    problems: summarize(problems),
  };
}

const toLocalDate = (value: Date): string => value.toISOString().slice(0, 10);

export type PreflightInput = {
  readonly prisma: PrismaClient;
  readonly environment: MatrixEnvironment;
  readonly fixtures: QaMatrixFixtures;
  readonly asOfDate: string;
  readonly ownerEmail: string;
  /**
   * How many cases the sweep will keep in flight. Checked against the owner's own entitlements:
   * the runner submits through the product's enforced path, so a concurrency the owner's plan
   * does not permit is a configuration error the preflight can name up front.
   */
  readonly concurrency: number;
  /** The real current date, which is what the loader's horizon is measured from. */
  readonly today: string;
  /** Repository root, for reading the migration directory. */
  readonly repositoryRoot: string;
};

/**
 * Runs every preflight check and reports them together.
 *
 * Checks are not short-circuited on the first failure: a developer fixing an environment wants the
 * whole list, and a partial report would hide the second problem behind the first for another
 * fifteen-minute cycle.
 */
export async function runQaMatrixPreflight(
  input: PreflightInput,
): Promise<QaMatrixPreflightReport> {
  const checks: PreflightCheck[] = [];

  checks.push(await checkDatabaseIdentity(input));
  checks.push(checkEnvironmentSafety(input));
  checks.push(await checkMigrations(input));

  const owner = await input.prisma.user.findFirst({
    where: { email: input.ownerEmail.trim().toLowerCase() },
    select: { id: true, email: true, plan: true, role: true },
  });
  checks.push(checkOwner(input, owner));

  checks.push(checkConfigFixtures(input));
  checks.push(checkCartesianProduct(input));
  checks.push(checkFixtureCompleteness(input));
  checks.push(checkProductHorizon(input));

  if (owner) {
    checks.push(await checkStrategyFixtures(input, owner.id));
    checks.push(await checkListFixtures(input, owner.id));
  }

  const calendar = await checkExecutionCalendar(input);
  checks.push(calendar.result);
  checks.push(await checkComparisonBenchmark(input));

  const symbols = await checkMissingSymbols(input, owner?.id ?? null);
  checks.push(symbols.result);

  checks.push(
    await checkSecurityCoverage(input, symbols.securities, calendar.calendar),
  );
  checks.push(await checkDerivedStateCoverage(input, symbols.securities));
  checks.push(await checkFundamentalsCoverage(input, symbols.securities));
  checks.push(await checkDatasetRevisions(input, symbols.securities));

  const failed = checks.filter((entry) => entry.status === "FAIL").length;
  const warned = checks.filter((entry) => entry.status === "WARN").length;

  return {
    ok: failed === 0,
    generatedAt: new Date().toISOString(),
    asOfDate: input.asOfDate,
    database: input.environment.databaseName,
    redis: `db ${input.environment.redisDb}`,
    checks,
    failed,
    warned,
  };
}

/** The database the connection actually landed in, asked of the server rather than of the URL. */
async function checkDatabaseIdentity(
  input: PreflightInput,
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const rows = await input.prisma.$queryRawUnsafe<
    { database: string; server: string }[]
  >(
    "select current_database() as database, inet_server_addr()::text as server",
  );
  const actual = rows[0]?.database ?? "";
  if (actual !== input.environment.databaseName) {
    problems.push(
      `Connected to \`${actual}\` but QA_MATRIX_DATABASE_URL names \`${input.environment.databaseName}\`.`,
    );
  }
  return check(
    "database-identity",
    "Database identity",
    problems,
    `connected to \`${actual}\` on ${input.environment.host}:${input.environment.port}`,
    { database: actual, host: input.environment.host },
  );
}

/**
 * That the matrix cannot reach development, test or production, and that its Redis is its own.
 *
 * `resolveMatrixEnvironment` has already refused each of these before a client existed; restating
 * them as a reported check is what puts them in the preflight output a reviewer reads, rather than
 * leaving "it did not throw" as the only evidence.
 */
function checkEnvironmentSafety(input: PreflightInput): PreflightCheck {
  const problems: string[] = [];
  const { environment } = input;

  if (process.env.NODE_ENV?.trim() === "production") {
    problems.push("NODE_ENV is production.");
  }
  // Compared against the connections as they were *before* this process was pointed at the matrix.
  // `DATABASE_URL` and `REDIS_URL` are overwritten in place, so reading them here would compare the
  // matrix with itself and report an isolation it never checked.
  const developmentDatabase = environment.developmentDatabaseUrl;
  if (developmentDatabase && developmentDatabase === environment.databaseUrl) {
    problems.push("The matrix database URL equals DATABASE_URL.");
  }
  const testDatabase = environment.testDatabaseUrl;
  if (testDatabase && testDatabase === environment.databaseUrl) {
    problems.push("The matrix database URL equals TEST_DATABASE_URL.");
  }
  if (!environment.databaseName.toLowerCase().includes("matrix")) {
    problems.push(
      `The database name \`${environment.databaseName}\` does not identify itself as a matrix environment.`,
    );
  }
  const baseRedis = environment.developmentRedisUrl;
  if (baseRedis) {
    try {
      const base = new URL(baseRedis);
      const matrix = new URL(environment.redisUrl);
      const baseDb = Number(base.pathname.replace(/^\//, "") || "0");
      if (base.host === matrix.host && baseDb === environment.redisDb) {
        problems.push(
          `Matrix Redis resolves to database ${environment.redisDb} on the same server the ` +
            "development stack uses, so cached projections, hydration locks and the FMP gate would be shared.",
        );
      }
    } catch {
      problems.push("REDIS_URL is not a valid URL.");
    }
  }

  return check(
    "environment-safety",
    "Environment safety",
    problems,
    `matrix database \`${environment.databaseName}\`, Redis database ${environment.redisDb}, ` +
      `isolated from development and test`,
    {
      nodeEnv: process.env.NODE_ENV ?? "(unset)",
      redisDb: environment.redisDb,
      developmentDatabase: environment.developmentDatabaseUrl?.replace(
        /\/\/[^@]*@/,
        "//",
      ),
      testDatabase: environment.testDatabaseUrl?.replace(/\/\/[^@]*@/, "//"),
      sourceDatabase: environment.sourceDatabaseUrl.replace(/\/\/[^@]*@/, "//"),
    },
  );
}

/**
 * That the matrix database carries every migration in the repository, and none half-applied.
 *
 * A missing migration is not a subtle failure — it is usually a missing column and an immediate
 * crash — but a *rolled back* or *failed* one is, because Prisma leaves the database usable and
 * every subsequent run silently executes against a schema nobody intended.
 */
async function checkMigrations(input: PreflightInput): Promise<PreflightCheck> {
  const problems: string[] = [];
  const directory = join(
    input.repositoryRoot,
    "packages/database/prisma/migrations",
  );
  const expected = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const applied = await input.prisma.$queryRawUnsafe<
    {
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }[]
  >(
    'select migration_name, finished_at, rolled_back_at from "_prisma_migrations" order by migration_name',
  );
  const byName = new Map(applied.map((row) => [row.migration_name, row]));

  for (const name of expected) {
    const row = byName.get(name);
    if (!row) {
      problems.push(`\`${name}\` has never been applied.`);
      continue;
    }
    if (row.rolled_back_at !== null) {
      problems.push(`\`${name}\` is recorded as rolled back.`);
    } else if (row.finished_at === null) {
      problems.push(`\`${name}\` started but never finished.`);
    }
  }
  for (const row of applied) {
    if (!expected.includes(row.migration_name)) {
      problems.push(
        `\`${row.migration_name}\` is applied but no longer exists in the repository.`,
      );
    }
  }

  return check(
    "migrations",
    "Migrations",
    problems,
    `${expected.length} migrations applied, current through \`${expected[expected.length - 1] ?? "—"}\``,
    { expected: expected.length, applied: applied.length },
  );
}

/**
 * The fixture owner exists, and their entitlements permit the sweep.
 *
 * The runner submits through the product's real entitlement-enforced path, so the owner's plan and
 * role are an input to whether a thousand cases can run at all — and a sweep that discovers that
 * on case one, fifteen minutes in, is a worse instrument than one that refuses up front. The
 * fixtures are owned by the QA_ADMIN persona because the matrix runs at a concurrency no
 * commercial plan sells; see `docs/decisions/entitlements-v1.md` and `matrix-execution.ts`.
 */
function checkOwner(
  input: PreflightInput,
  owner: {
    id: string;
    email: string;
    plan: UserPlan;
    role: UserRole;
  } | null,
): PreflightCheck {
  if (!owner) {
    return check(
      "qa-owner",
      "QA fixture owner",
      [
        `The QA persona \`${input.ownerEmail}\` does not exist in this database. The matrix ` +
          "Strategies and Lists are owned by that account; run the QA user seed against the " +
          "matrix database first.",
      ],
      "",
      undefined,
    );
  }

  const entitlements = resolveEntitlements({
    kind: "AUTHENTICATED",
    userId: owner.id,
    plan: owner.plan,
    role: owner.role,
  });
  const problems: string[] = [];
  if (!withinLimit(entitlements.backtests.maxConcurrentRuns, input.concurrency)) {
    problems.push(
      `\`${owner.email}\` may run ${entitlements.backtests.maxConcurrentRuns} backtests at ` +
        `once, but the sweep is configured for ${input.concurrency}. Lower --concurrency, or ` +
        "run the matrix as the QA_ADMIN persona the fixtures are meant to be owned by.",
    );
  }
  if (!withinLimit(entitlements.backtests.maxHistoricalYears, BACKTEST_MAX_PERIOD_YEARS)) {
    problems.push(
      `\`${owner.email}\` may request ${entitlements.backtests.maxHistoricalYears} years of ` +
        `backtest history, and the matrix configurations reach ${BACKTEST_MAX_PERIOD_YEARS}.`,
    );
  }

  return check(
    "qa-owner",
    "QA fixture owner",
    problems,
    `\`${owner.email}\` (${owner.role}, plan ${owner.plan}) owns the matrix fixtures`,
    {
      ownerUserId: owner.id,
      plan: owner.plan,
      role: owner.role,
      maxConcurrentRuns: entitlements.backtests.maxConcurrentRuns,
    },
  );
}

/**
 * Exactly ten Strategies, in the reserved namespace, matching the definitions byte for byte.
 *
 * Counting rows would prove only that ten things exist. The definition each row carries is what a
 * run snapshots and executes, so a drifted definition is a matrix that is no longer the matrix its
 * report claims — checked by re-normalizing the fixture and comparing to the stored document.
 */
async function checkStrategyFixtures(
  input: PreflightInput,
  ownerUserId: string,
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const rows = await input.prisma.strategy.findMany({
    where: {
      userId: ownerUserId,
      name: { startsWith: `${QA_MATRIX_NAME_PREFIX}S` },
    },
    include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
  });

  if (rows.length !== QA_MATRIX_EXPECTED_STRATEGIES) {
    problems.push(
      `Expected exactly ${QA_MATRIX_EXPECTED_STRATEGIES} QA-MATRIX strategies, found ${rows.length}.`,
    );
  }

  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const fixture of input.fixtures.strategies) {
    const row = byName.get(fixture.name);
    if (!row) {
      problems.push(`\`${fixture.name}\` is missing.`);
      continue;
    }
    const version = row.versions[0];
    if (!version) {
      problems.push(`\`${fixture.name}\` has no saved definition.`);
      continue;
    }
    const stored = JSON.stringify(
      normalizeStrategyDefinition(version.definition),
    );
    const wanted = JSON.stringify(
      normalizeStrategyDefinition(fixture.definition),
    );
    if (stored !== wanted) {
      problems.push(
        `\`${fixture.name}\` version ${version.versionNumber} does not match the fixture definition; re-seed the matrix.`,
      );
    }
  }
  for (const row of rows) {
    if (!input.fixtures.strategies.some((f) => f.name === row.name)) {
      problems.push(
        `\`${row.name}\` exists in the database but is not a defined matrix fixture.`,
      );
    }
  }

  return check(
    "fixture-strategies",
    "QA fixture Strategies",
    problems,
    `exactly ${QA_MATRIX_EXPECTED_STRATEGIES} Strategies, definitions matching the fixtures`,
    { found: rows.length },
  );
}

/** Exactly ten Stock Lists, with the membership and normalized buy windows the fixtures define. */
async function checkListFixtures(
  input: PreflightInput,
  ownerUserId: string,
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const rows = await input.prisma.stockList.findMany({
    where: {
      userId: ownerUserId,
      name: { startsWith: `${QA_MATRIX_NAME_PREFIX}L` },
    },
    include: {
      items: { include: { security: true, buyWindows: true } },
    },
  });

  if (rows.length !== QA_MATRIX_EXPECTED_LISTS) {
    problems.push(
      `Expected exactly ${QA_MATRIX_EXPECTED_LISTS} QA-MATRIX stock lists, found ${rows.length}.`,
    );
  }

  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const fixture of input.fixtures.lists) {
    const row = byName.get(fixture.name);
    if (!row) {
      problems.push(`\`${fixture.name}\` is missing.`);
      continue;
    }
    if (row.items.length === 0) {
      problems.push(`\`${fixture.name}\` has no members.`);
      continue;
    }
    const storedSymbols = row.items
      .map((item) => item.security.symbol)
      .sort()
      .join(",");
    const wantedSymbols = fixture.members
      .map((member) => member.symbol)
      .sort()
      .join(",");
    if (storedSymbols !== wantedSymbols) {
      problems.push(
        `\`${fixture.name}\` membership is [${storedSymbols}] but the fixture defines [${wantedSymbols}].`,
      );
    }
    for (const member of fixture.members) {
      const item = row.items.find(
        (candidate) => candidate.security.symbol === member.symbol,
      );
      if (!item) {
        continue;
      }
      const storedWindows = item.buyWindows
        .map(
          (window) =>
            `${toLocalDate(window.startDate)}→${
              window.endDate ? toLocalDate(window.endDate) : "open"
            }`,
        )
        .sort()
        .join(" ");
      const wantedWindows = member.ranges
        .map((range) => `${range.startDate}→${range.endDate ?? "open"}`)
        .sort()
        .join(" ");
      if (item.buyWindowMode !== member.mode) {
        problems.push(
          `\`${fixture.name}\`/${member.symbol} is ${item.buyWindowMode} but the fixture defines ${member.mode}.`,
        );
      } else if (storedWindows !== wantedWindows) {
        problems.push(
          `\`${fixture.name}\`/${member.symbol} buy windows are [${storedWindows}] but the fixture defines [${wantedWindows}]. ` +
            "Re-seed with the same QA_MATRIX_AS_OF_DATE the sweep will use.",
        );
      }
    }
  }
  for (const row of rows) {
    if (!input.fixtures.lists.some((f) => f.name === row.name)) {
      problems.push(
        `\`${row.name}\` exists in the database but is not a defined matrix fixture.`,
      );
    }
  }

  return check(
    "fixture-lists",
    "QA fixture Stock Lists",
    problems,
    `exactly ${QA_MATRIX_EXPECTED_LISTS} Lists, membership and buy windows matching the fixtures`,
    { found: rows.length },
  );
}

/**
 * Exactly ten configurations, each accepted by the product's own submission parser.
 *
 * Configurations are repository fixtures rather than rows, so "are they present" is not the
 * question — "would the API accept this body" is. Parsing them here means a period the validator
 * would reject is a preflight failure rather than a thousand rejected submissions.
 *
 * Parsed against `input.today` — the day the sweep will actually submit on — rather than against
 * the parser's own real clock. The two are the same in production and deliberately different in a
 * test, and the drift between the pinned matrix clock and today is reported by its own check
 * (`product-horizon`) with the instruction to re-seed, not smuggled in here as ten rejections.
 */
function checkConfigFixtures(input: PreflightInput): PreflightCheck {
  const problems: string[] = [];
  const configs = input.fixtures.configs;
  if (configs.length !== QA_MATRIX_EXPECTED_CONFIGS) {
    problems.push(
      `Expected exactly ${QA_MATRIX_EXPECTED_CONFIGS} configurations, found ${configs.length}.`,
    );
  }
  const ids = new Set<string>();
  for (const config of configs) {
    if (ids.has(config.id)) {
      problems.push(`Duplicate configuration id \`${config.id}\`.`);
    }
    ids.add(config.id);
    try {
      parseCreateBacktestRunRequest(
        {
          strategyId: "00000000-0000-4000-8000-000000000000",
          stockListId: "00000000-0000-4000-8000-000000000001",
          ...config.request,
        },
        input.today,
      );
    } catch (error) {
      problems.push(
        `\`${config.name}\` is rejected by the submission validator: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return check(
    "fixture-configs",
    "Backtest configurations",
    problems,
    `exactly ${QA_MATRIX_EXPECTED_CONFIGS} configurations, all accepted by the submission validator`,
    { found: configs.length },
  );
}

/** Ten by ten by ten is a thousand, and every identity is distinct. */
function checkCartesianProduct(input: PreflightInput): PreflightCheck {
  const problems: string[] = [];
  const cases = qaMatrixCases(input.fixtures);
  if (cases.length !== QA_MATRIX_TOTAL_CASES) {
    problems.push(
      `Enumeration produced ${cases.length} combinations; the matrix is defined as ${QA_MATRIX_TOTAL_CASES}.`,
    );
  }
  const labels = new Set(cases.map((entry) => entry.label));
  if (labels.size !== cases.length) {
    problems.push(
      `${cases.length - labels.size} combination identities are duplicated.`,
    );
  }
  const expected =
    input.fixtures.strategies.length *
    input.fixtures.lists.length *
    input.fixtures.configs.length;
  if (expected !== QA_MATRIX_EXPECTED_COMBINATIONS) {
    problems.push(
      `${input.fixtures.strategies.length} x ${input.fixtures.lists.length} x ${input.fixtures.configs.length} = ${expected}, not ${QA_MATRIX_EXPECTED_COMBINATIONS}.`,
    );
  }
  return check(
    "cartesian-product",
    "Cartesian product",
    problems,
    `${cases.length} unique combinations (${input.fixtures.strategies.length} x ${input.fixtures.lists.length} x ${input.fixtures.configs.length})`,
    { combinations: cases.length },
  );
}

/**
 * That no fixture definition is half-written.
 *
 * A Strategy with no BUY level, a List with no members or a configuration with a zero-length period
 * would all execute — producing a run that completes with nothing in it, which reads in a report as
 * "a strategy that legitimately did not trade".
 */
function checkFixtureCompleteness(input: PreflightInput): PreflightCheck {
  const problems: string[] = [];
  for (const strategy of input.fixtures.strategies) {
    const definition = normalizeStrategyDefinition(strategy.definition);
    if (definition.buyLevels.length === 0) {
      problems.push(`\`${strategy.name}\` defines no BUY level.`);
    }
    for (const level of definition.buyLevels) {
      if (level.signal.conditions.length === 0 && !level.signal.trigger) {
        problems.push(
          `\`${strategy.name}\` BUY level \`${level.id}\` has an empty Signal.`,
        );
      }
    }
  }
  for (const list of input.fixtures.lists) {
    if (list.members.length === 0) {
      problems.push(`\`${list.name}\` has no members.`);
    }
    for (const member of list.members) {
      if (member.mode === "CUSTOM" && member.ranges.length === 0) {
        problems.push(
          `\`${list.name}\`/${member.symbol} is CUSTOM with no ranges.`,
        );
      }
    }
  }
  for (const config of input.fixtures.configs) {
    if (config.request.startDate >= config.request.endDate) {
      problems.push(
        `\`${config.name}\` has a period that does not move forward (${config.request.startDate} → ${config.request.endDate}).`,
      );
    }
  }
  return check(
    "fixture-completeness",
    "Fixture completeness",
    problems,
    "every Strategy has a BUY level with a Signal, every List has members, every period advances",
  );
}

/**
 * That no configuration asks for history outside the product horizon.
 *
 * This is the failure the fixtures' matrix clock exists to prevent, and it is checked rather than
 * trusted: the loader clips a projection to `[today - 30y, today]` **silently**, so a period that
 * has drifted outside the horizon produces a shorter run than the report will claim.
 */
function checkProductHorizon(input: PreflightInput): PreflightCheck {
  const problems: string[] = [];
  const horizonStart = subtractYears(input.asOfDate, BACKTEST_MAX_PERIOD_YEARS);
  /**
   * The horizon the **API** will enforce at submission, from the real clock — not the pinned one.
   *
   * A sweep pins its clock so the fixtures are reproducible, which is right, but a pin older than
   * today puts the three configurations that start exactly on the horizon outside the period the
   * product will accept. `parseCreateBacktestRunRequest` refuses them, and the sweep fails at
   * submission rather than partway through.
   *
   * It used to be worse, which is why this check exists at all: the loader clipped every
   * projection to `[today - productHistoryYears, today]` **silently**, so a drifted pin did not
   * fail — it produced a shorter run than the report claimed. A sweep pinned to 2026-09-09 and
   * executed on 2026-09-10 simulated 7,546 sessions instead of 7,547, losing exactly the first
   * execution date the thirty-year configurations exist to exercise. The backtest read path is now
   * bounded by what is retained rather than by the current clock, so the silent version is gone;
   * this check is what turns the remaining loud failure into one a preflight reports first.
   */
  const loaderHorizonStart = subtractYears(
    input.today,
    getStockDataConfig().productHistoryYears,
  );
  for (const config of input.fixtures.configs) {
    if (config.request.startDate < horizonStart) {
      problems.push(
        `\`${config.name}\` starts ${config.request.startDate}, before the product horizon ${horizonStart}. ` +
          "The loader would clip it without a word.",
      );
    }
    if (config.request.startDate < loaderHorizonStart) {
      problems.push(
        `\`${config.name}\` starts ${config.request.startDate}, but the selectable horizon today ` +
          `(${input.today}) begins ${loaderHorizonStart}. The matrix clock \`${input.asOfDate}\` has ` +
          "drifted behind it, so the submission would be refused. Re-seed and run with " +
          `QA_MATRIX_AS_OF_DATE=${input.today}.`,
      );
    }
    if (config.request.endDate > input.asOfDate) {
      problems.push(
        `\`${config.name}\` ends ${config.request.endDate}, after the matrix clock ${input.asOfDate}.`,
      );
    }
  }
  return check(
    "product-horizon",
    "Requested periods inside the product horizon",
    problems,
    `every period inside [${horizonStart}, ${input.asOfDate}], and inside the loader's own ` +
      `horizon from ${loaderHorizonStart}`,
    {
      horizonStart,
      loaderHorizonStart,
      asOfDate: input.asOfDate,
      today: input.today,
    },
  );
}

/**
 * That the pinned execution-calendar series covers every requested period.
 *
 * The calendar is the portfolio's date axis, so a series that starts inside a thirty-year period
 * does not fail the run — it silently makes it a shorter run whose first simulated date, return
 * base and contribution schedule are all different from the ones the configuration asked for. That
 * is the single most important thing this preflight exists to catch, and it is what makes the
 * lightweight test database unusable for the matrix.
 */
async function checkExecutionCalendar(input: PreflightInput): Promise<{
  result: PreflightCheck;
  calendar: ExecutionCalendar | null;
}> {
  const problems: string[] = [];
  const series = (
    await input.prisma.benchmark.findFirst({
      where: { code: EXECUTION_CALENDAR_REFERENCE_CODE },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    })
  )?.series[0];

  if (!series) {
    return {
      result: check(
        "execution-calendar",
        "Execution calendar coverage",
        [
          `The \`${EXECUTION_CALENDAR_REFERENCE_CODE}\` benchmark has no series in this database, ` +
            "so no run could pin an execution calendar.",
        ],
        "",
      ),
      calendar: null,
    };
  }

  const bars = await input.prisma.benchmarkDailyPrice.findMany({
    where: { seriesId: series.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const dates = bars.map((bar) => toLocalDate(bar.date));
  const calendar = new ExecutionCalendar(dates);

  if (dates.length === 0) {
    problems.push(
      `The pinned \`${EXECUTION_CALENDAR_REFERENCE_CODE}\` series carries no bars.`,
    );
  } else {
    for (const config of input.fixtures.configs) {
      const first = calendar.onOrAfter(config.request.startDate);
      const last = calendar.onOrBefore(config.request.endDate);
      if (!first || first > config.request.endDate) {
        problems.push(
          `\`${config.name}\` (${config.request.startDate} → ${config.request.endDate}) has no execution date at all.`,
        );
        continue;
      }
      if ((calendar.first as string) > config.request.startDate) {
        problems.push(
          `\`${config.name}\` starts ${config.request.startDate} but the calendar only begins ` +
            `${calendar.first as string}; the run would silently simulate ${first} onwards.`,
        );
      }
      if (!last || (calendar.last as string) < config.request.endDate) {
        problems.push(
          `\`${config.name}\` ends ${config.request.endDate} but the calendar only reaches ` +
            `${calendar.last as string}.`,
        );
      }
    }
  }

  // The boundary fixtures were cut against a calendar; if it was not this one, `L10`'s windows name
  // dates no run will simulate and the boundary cases silently test nothing.
  const fixtureCalendar = input.fixtures.calendar;
  if (
    dates.length > 0 &&
    (fixtureCalendar.length !== calendar.length ||
      fixtureCalendar.first !== calendar.first ||
      fixtureCalendar.last !== calendar.last)
  ) {
    problems.push(
      `The fixtures were resolved against a calendar of ${fixtureCalendar.length} dates ` +
        `(${fixtureCalendar.first ?? "—"} → ${fixtureCalendar.last ?? "—"}) but this database's ` +
        `series holds ${calendar.length} (${calendar.first ?? "—"} → ${calendar.last ?? "—"}). ` +
        "Re-seed the matrix so the boundary windows name dates these runs actually simulate.",
    );
  }

  return {
    result: check(
      "execution-calendar",
      "Execution calendar coverage",
      problems,
      `${dates.length} sessions, ${calendar.first ?? "—"} → ${calendar.last ?? "—"}, covering every configuration`,
      {
        seriesId: series.id,
        sessions: dates.length,
        from: calendar.first ?? null,
        to: calendar.last ?? null,
      },
    ),
    calendar,
  };
}

/** The comparison benchmark, which is a separate concern from the calendar even when it is the same series. */
async function checkComparisonBenchmark(
  input: PreflightInput,
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const codes = new Set(
    input.fixtures.configs.map(
      (config) => config.request.benchmarkCode || DEFAULT_BENCHMARK_CODE,
    ),
  );
  const facts: Record<string, unknown> = {};
  for (const code of codes) {
    const benchmark = await input.prisma.benchmark.findFirst({
      where: { code, isActive: true },
      include: { series: { orderBy: { version: "desc" }, take: 1 } },
    });
    const series = benchmark?.series[0];
    if (!benchmark || !series) {
      problems.push(`\`${code}\` is not a selectable benchmark with a series.`);
      continue;
    }
    const bounds = await input.prisma.benchmarkDailyPrice.aggregate({
      where: { seriesId: series.id },
      _min: { date: true },
      _max: { date: true },
      _count: true,
    });
    if (!bounds._min.date || !bounds._max.date) {
      problems.push(`\`${code}\` series ${series.version} carries no bars.`);
      continue;
    }
    const from = toLocalDate(bounds._min.date);
    const to = toLocalDate(bounds._max.date);
    facts[code] = { bars: bounds._count, from, to };
    for (const config of input.fixtures.configs) {
      if (from > config.request.startDate) {
        problems.push(
          `\`${code}\` starts ${from}, after \`${config.name}\` begins ${config.request.startDate}; ` +
            "a benchmark whose history starts mid-run has no comparable growth figure.",
        );
        break;
      }
    }
  }
  return check(
    "comparison-benchmark",
    "Comparison benchmark coverage",
    problems,
    `${[...codes].join(", ")} covers every configuration period`,
    facts,
  );
}

type SecurityRow = {
  readonly id: string;
  readonly symbol: string;
  readonly listedOn: string | null;
  readonly fixture: QaMatrixSecurity | undefined;
  /** Every configuration period this security is actually reachable in, via its lists. */
  readonly periods: readonly { start: string; end: string }[];
};

/**
 * Every symbol a matrix list references resolves to a catalog row.
 *
 * `Security` is the identity authority for list membership, so a missing row is not a data gap that
 * degrades a run — it is a list the product cannot resolve.
 */
async function checkMissingSymbols(
  input: PreflightInput,
  ownerUserId: string | null,
): Promise<{ result: PreflightCheck; securities: readonly SecurityRow[] }> {
  const problems: string[] = [];
  const wanted = new Map<string, { start: string; end: string }[]>();
  const periods = input.fixtures.configs.map((config) => ({
    start: config.request.startDate,
    end: config.request.endDate,
  }));
  for (const list of input.fixtures.lists) {
    for (const member of list.members) {
      if (!wanted.has(member.symbol)) {
        wanted.set(member.symbol, periods);
      }
    }
  }

  const rows = await input.prisma.security.findMany({
    where: { symbol: { in: [...wanted.keys()] } },
    select: { id: true, symbol: true, ipoDate: true },
  });
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));

  const securities: SecurityRow[] = [];
  for (const [symbol, symbolPeriods] of wanted) {
    const row = bySymbol.get(symbol);
    if (!row) {
      problems.push(`\`${symbol}\` has no Security row in the catalog.`);
      continue;
    }
    securities.push({
      id: row.id,
      symbol,
      listedOn: row.ipoDate ? toLocalDate(row.ipoDate) : null,
      fixture: QA_MATRIX_SECURITIES.find((entry) => entry.symbol === symbol),
      periods: symbolPeriods,
    });
  }

  if (ownerUserId) {
    // A list row referencing a security the fixtures do not name is drift the seeder would repair.
    const orphaned = await input.prisma.stockListItem.count({
      where: {
        stockList: {
          userId: ownerUserId,
          name: { startsWith: `${QA_MATRIX_NAME_PREFIX}L` },
        },
        security: { symbol: { notIn: [...wanted.keys()] } },
      },
    });
    if (orphaned > 0) {
      problems.push(
        `${orphaned} persisted matrix list member(s) reference a symbol the fixtures do not define.`,
      );
    }
  }

  return {
    result: check(
      "missing-symbols",
      "Missing symbols",
      problems,
      `all ${wanted.size} referenced symbols resolve to catalog rows`,
      { symbols: wanted.size },
    ),
    securities,
  };
}

/**
 * That every security has the daily prices its runs will read.
 *
 * Checked against the rows themselves rather than against `StockDatasetCoverage`, because the rows
 * are what the day loop reads and the coverage watermark is what decides whether the loader calls
 * the provider. Both matter and they are reported separately: a security with the rows but without
 * the coverage interval executes correctly *and* re-hydrates from FMP mid-sweep.
 *
 * A later listing is not a gap. `no fabricated pre-listing data` is a requirement, so a security
 * whose first bar is at its own listing date is correct — what is checked is that a security listed
 * *before* a period starts has data from the start of that period.
 */
async function checkSecurityCoverage(
  input: PreflightInput,
  securities: readonly SecurityRow[],
  calendar: ExecutionCalendar | null,
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const facts: Record<string, unknown> = {};
  /** A listing may take a few sessions to produce its first canonical bar. */
  const LISTING_TOLERANCE_DAYS = 14;

  let earliest = "9999-12-31";
  let latest = "0000-01-01";

  for (const security of securities) {
    const bounds = await input.prisma.dailyPrice.aggregate({
      where: { securityId: security.id },
      _min: { date: true },
      _max: { date: true },
      _count: true,
    });
    if (!bounds._min.date || !bounds._max.date) {
      problems.push(`\`${security.symbol}\` has no daily prices at all.`);
      continue;
    }
    const from = toLocalDate(bounds._min.date);
    const to = toLocalDate(bounds._max.date);
    earliest = from < earliest ? from : earliest;
    latest = to > latest ? to : latest;

    const listed = security.listedOn ?? security.fixture?.listedOn ?? null;
    for (const period of security.periods) {
      const requiredFrom =
        listed && listed > period.start
          ? addDays(listed, LISTING_TOLERANCE_DAYS)
          : period.start;
      if (from > requiredFrom) {
        problems.push(
          `\`${security.symbol}\` prices begin ${from}, after ${requiredFrom} ` +
            (listed && listed > period.start
              ? `(listed ${listed}).`
              : `(a period starts ${period.start}).`),
        );
        break;
      }
    }
    const requiredTo = calendar?.onOrBefore(
      security.periods.reduce(
        (max, p) => (p.end > max ? p.end : max),
        "0000-01-01",
      ),
    );
    if (requiredTo && to < requiredTo) {
      problems.push(
        `\`${security.symbol}\` prices end ${to}, before the last execution date ${requiredTo} the matrix simulates.`,
      );
    }
  }

  facts.pricesFrom = earliest;
  facts.pricesTo = latest;
  facts.securities = securities.length;

  // The 34-year raw-price retention is unchanged by the matrix, and the thirty-year configurations
  // sit exactly on the product horizon — so the long-listed securities must carry bars *before* it.
  // That warm-up history is what makes a 200-week average valid on the first simulated day, and it
  // must never itself become a simulated date (validated per run as invariant 40).
  const horizonStart = subtractYears(input.asOfDate, BACKTEST_MAX_PERIOD_YEARS);
  const warmupMissing = securities.filter(
    (security) =>
      security.fixture?.coverage === "FULL_HORIZON" && earliest >= horizonStart,
  );
  if (warmupMissing.length > 0 && earliest >= horizonStart) {
    problems.push(
      `No security carries price history before the product horizon ${horizonStart}; the derived ` +
        "series a thirty-year run reads on its first simulated day would be warming up inside the run.",
    );
  }

  return check(
    "security-coverage",
    "Security price coverage",
    problems,
    `${securities.length} securities, prices ${earliest} → ${latest}, covering every period from listing`,
    facts,
  );
}

/** Derived state at the current revision, over the same span the prices cover. */
async function checkDerivedStateCoverage(
  input: PreflightInput,
  securities: readonly SecurityRow[],
): Promise<PreflightCheck> {
  const problems: string[] = [];
  for (const security of securities) {
    const bounds = await input.prisma.dailyDerivedState.aggregate({
      where: { securityId: security.id },
      _min: { date: true },
      _max: { date: true },
      _count: true,
    });
    if (!bounds._min.date || !bounds._max.date) {
      problems.push(
        `\`${security.symbol}\` has no derived state; every moving average and oscillator would be NOT_EVALUABLE.`,
      );
      continue;
    }
    const prices = await input.prisma.dailyPrice.aggregate({
      where: { securityId: security.id },
      _count: true,
    });
    if (bounds._count < prices._count) {
      problems.push(
        `\`${security.symbol}\` has ${bounds._count} derived rows for ${prices._count} price rows; ` +
          "the loader would rebuild the difference during the sweep.",
      );
    }
  }
  return check(
    "derived-state-coverage",
    "Derived state coverage",
    problems,
    `derived state present for all ${securities.length} securities at revision ${BACKTEST_DATA_REVISIONS.derivedStateRevision}`,
    { revision: DAILY_DERIVED_STATE_VARIANT },
  );
}

/**
 * Fundamentals, but only where a Strategy actually reads them.
 *
 * Requiring statements for every security would be a stricter rule than the product's, and would
 * fail an environment that is entirely adequate for nine of the ten Strategies. What is required is
 * that the intrinsic-value Strategies can be evaluated at all — `S09` reads Margin of Safety
 * against two sources, and its deliberate `NOT_EVALUABLE` probe is only meaningful if the *other*
 * securities do have the statements.
 */
async function checkFundamentalsCoverage(
  input: PreflightInput,
  securities: readonly SecurityRow[],
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const requiring = input.fixtures.strategies.filter((strategy) =>
    collectOperands(normalizeStrategyDefinition(strategy.definition)).some(
      (operand) => operandNeedsFundamentals(operand),
    ),
  );

  if (requiring.length === 0) {
    return check(
      "fundamentals-coverage",
      "Fundamentals coverage",
      [],
      "no Strategy reads an intrinsic-value operand",
    );
  }

  let covered = 0;
  const missing: string[] = [];
  for (const security of securities) {
    const statements = await input.prisma.financialStatement.count({
      where: { securityId: security.id },
    });
    if (statements === 0) {
      missing.push(security.symbol);
    } else {
      covered += 1;
    }
  }

  // Every security missing statements is a warning rather than a failure: an intrinsic value that
  // cannot be computed is NOT_EVALUABLE, which is correct behaviour and is what `S09` probes. All
  // of them missing is a failure, because then the valuation Strategies test nothing.
  if (covered === 0) {
    problems.push(
      `${requiring.length} Strategy fixture(s) read intrinsic-value operands and no security in ` +
        "the matrix carries a single financial statement, so every valuation predicate would be NOT_EVALUABLE.",
    );
  }

  const warnings =
    missing.length > 0 && covered > 0
      ? [
          `${missing.length} securities carry no financial statements (${missing
            .slice(0, 8)
            .join(
              ", ",
            )}${missing.length > 8 ? ", …" : ""}); their valuation predicates stay NOT_EVALUABLE.`,
        ]
      : [];

  if (problems.length > 0) {
    return check(
      "fundamentals-coverage",
      "Fundamentals coverage",
      problems,
      "",
      { strategiesRequiring: requiring.map((s) => s.id) },
    );
  }
  return check(
    "fundamentals-coverage",
    "Fundamentals coverage",
    warnings,
    `${covered}/${securities.length} securities carry statements for ${requiring
      .map((s) => s.id)
      .join(", ")}`,
    { strategiesRequiring: requiring.map((s) => s.id), covered },
    "WARN",
  );
}

function operandNeedsFundamentals(operand: string): boolean {
  if (operand === PRICE_OPERAND) {
    return false;
  }
  if (operand.startsWith("margin-of-safety:")) {
    return true;
  }
  if (operand.startsWith("series:")) {
    const series = findSelectableSeries(
      operand.slice("series:".length) as SelectableSeriesId,
    );
    return (
      series?.source.kind === "INTRINSIC_VALUE_MODEL" ||
      series?.source.kind === "INTRINSIC_VALUE_BLEND"
    );
  }
  return false;
}

/**
 * That the persisted dataset revisions are the ones this build interprets.
 *
 * A stale revision is the quietest expensive failure available: the worker does not refuse it — the
 * runtime-compatibility guard compares a *run snapshot* against the build, and a fresh submission
 * always matches — so instead the loader decides the materialized data is incompatible and rebuilds
 * it, security by security, from the provider, in the middle of a timed sweep.
 */
async function checkDatasetRevisions(
  input: PreflightInput,
  securities: readonly SecurityRow[],
): Promise<PreflightCheck> {
  const problems: string[] = [];
  const expectedPriceVariant = `${DAILY_PRICE_VARIANT_FAMILY}:v${PRICE_DATASET_VERSION}`;

  const states = await input.prisma.stockDatasetState.findMany({
    where: { securityId: { in: securities.map((s) => s.id) } },
    select: { securityId: true, dataset: true, variant: true },
  });
  const bySecurity = new Map<string, Set<string>>();
  for (const state of states) {
    const key = `${state.dataset}|${state.variant}`;
    const existing = bySecurity.get(state.securityId) ?? new Set<string>();
    existing.add(key);
    bySecurity.set(state.securityId, existing);
  }

  for (const security of securities) {
    const variants = bySecurity.get(security.id) ?? new Set<string>();
    if (!variants.has(`DAILY_PRICE|${expectedPriceVariant}`)) {
      problems.push(
        `\`${security.symbol}\` has no DAILY_PRICE coverage at \`${expectedPriceVariant}\`; ` +
          "the loader would treat its history as unmaterialized and re-hydrate it.",
      );
    }
    if (!variants.has(`DAILY_DERIVED_STATE|${DAILY_DERIVED_STATE_VARIANT}`)) {
      problems.push(
        `\`${security.symbol}\` has no DAILY_DERIVED_STATE at \`${DAILY_DERIVED_STATE_VARIANT}\`; ` +
          "its derived series would be recalculated during the sweep.",
      );
    }
  }

  const stale = states.filter(
    (state) =>
      state.dataset === "DAILY_DERIVED_STATE" &&
      state.variant !== DAILY_DERIVED_STATE_VARIANT,
  );

  return check(
    "dataset-revisions",
    "Dataset revisions",
    problems,
    `prices at \`${expectedPriceVariant}\`, derived state at \`${DAILY_DERIVED_STATE_VARIANT}\`, ` +
      `fundamentals v${BACKTEST_DATA_REVISIONS.fundamentalsVariantVersion}`,
    {
      expected: BACKTEST_DATA_REVISIONS,
      staleDerivedStateRows: stale.length,
    },
  );
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The preflight as a developer reads it in a terminal. */
export function formatPreflightReport(report: QaMatrixPreflightReport): string {
  const icon = (status: PreflightStatus): string =>
    status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : "FAIL";
  const lines: string[] = [
    "QA MATRIX PREFLIGHT",
    "===================",
    `database   ${report.database}`,
    `redis      ${report.redis}`,
    `clock      ${report.asOfDate}`,
    `generated  ${report.generatedAt}`,
    "",
  ];
  for (const entry of report.checks) {
    lines.push(`[${icon(entry.status)}] ${entry.title}`);
    lines.push(`       ${entry.detail}`);
    for (const problem of entry.problems ?? []) {
      lines.push(`       - ${problem}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? `PREFLIGHT GREEN — ${report.checks.length} checks, ${report.warned} warning(s).`
      : `PREFLIGHT FAILED — ${report.failed} of ${report.checks.length} checks failed.`,
  );
  return lines.join("\n");
}
