import { ExecutionCalendar } from "@intrinsic/strategy";
import {
  currentAsOfDate,
  qaMatrixPeriods,
  type QaMatrixPeriods,
} from "./clock.js";
import { CAPTURED_EXECUTION_CALENDAR_DATES } from "./captured-execution-calendar.js";
import { qaMatrixConfigs, type QaMatrixConfigFixture } from "./configs.js";
import { qaMatrixLists, type QaMatrixListFixture } from "./lists.js";
import {
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_STRATEGIES,
  type QaMatrixStrategyFixture,
} from "./strategies.js";

export * from "./captured-execution-calendar.js";
export * from "./clock.js";
export * from "./configs.js";
export * from "./lists.js";
export * from "./securities.js";
export * from "./strategies.js";

/**
 * The deterministic Backtest V1 validation matrix: ten Strategies x ten Stock Lists x ten Backtest
 * configurations = one thousand reproducible runs.
 *
 * Strategies and Lists are **persistent QA entities** owned by the `QA_USER` persona in the test
 * database, seeded by `pnpm test:matrix:seed`. Configurations are **repository fixtures**, because
 * the domain has no persistent configuration entity — see `configs.ts`.
 *
 * The matrix is a pure function of one declared clock. Strategies are clock-independent; the
 * periods, and the trading sessions the `L10` boundary windows are cut against, are not — the
 * product horizon moves with the calendar, so a fixture pinned to a literal date would ask for
 * history the loader silently clips. See `clock.ts`.
 *
 * Everything here is inert data plus pure functions. It creates no runs, executes nothing, and
 * reaches no database: seeding lives in `apps/api/src/qa-matrix`, and the runner that will execute
 * the thousand combinations is deliberately a later, backend-level piece of work.
 *
 * See `docs/development/qa-matrix-fixtures.md`.
 */

export const QA_MATRIX_EXPECTED_STRATEGIES = 10;
export const QA_MATRIX_EXPECTED_LISTS = 10;
export const QA_MATRIX_EXPECTED_CONFIGS = 10;
export const QA_MATRIX_EXPECTED_COMBINATIONS = 1_000;

/** The complete fixture set for one clock and one authoritative execution calendar. */
export type QaMatrixFixtures = {
  readonly periods: QaMatrixPeriods;
  /** The execution-date set every session-shaped fixture value was resolved against. */
  readonly calendar: ExecutionCalendar;
  readonly strategies: readonly QaMatrixStrategyFixture[];
  readonly lists: readonly QaMatrixListFixture[];
  readonly configs: readonly QaMatrixConfigFixture[];
};

/**
 * Resolves the whole matrix for a clock and an authoritative execution-date set.
 *
 * The clock defaults to today rather than a pinned literal deliberately: a literal is correct only
 * on the day it is written, and the failure it causes — a period reaching past the product horizon
 * and being clipped without a word — is invisible in the result.
 *
 * `executionCalendarDates` defaults to the **captured** snapshot of the pinned execution-calendar
 * series, which is what lets the offline suites resolve boundary dates with no database. Anything
 * with a live database should pass the rows it read instead: the seeder does, so the fixtures it
 * persists are cut against the very calendar those runs will execute on.
 */
export function qaMatrixFixtures(
  asOfDate: string = currentAsOfDate(),
  executionCalendarDates: readonly string[] = CAPTURED_EXECUTION_CALENDAR_DATES,
): QaMatrixFixtures {
  const calendar = new ExecutionCalendar(executionCalendarDates);
  const periods = qaMatrixPeriods(asOfDate, calendar);
  return {
    periods,
    calendar,
    strategies: QA_MATRIX_STRATEGIES,
    lists: qaMatrixLists(periods, calendar),
    configs: qaMatrixConfigs(periods),
  };
}

/** `QA-MATRIX-S04-L09-C06`: the reproducible identity of one cell of the matrix. */
export type QaMatrixCombination = {
  readonly label: string;
  readonly strategy: QaMatrixStrategyFixture;
  readonly list: QaMatrixListFixture;
  readonly config: QaMatrixConfigFixture;
};

/** The naming convention, in one place: `QA-MATRIX-Sxx-Lxx-Cxx`. */
export function qaMatrixRunLabel(
  strategyId: string,
  listId: string,
  configId: string,
): string {
  return `${QA_MATRIX_NAME_PREFIX}${strategyId}-${listId}-${configId}`;
}

/**
 * Every combination, in a fixed order: strategy, then list, then configuration.
 *
 * Enumerated rather than sampled, and ordered rather than shuffled, so a partially completed matrix
 * resumes at a known index and two enumerations of one clock are always the same sequence.
 */
export function qaMatrixCombinations(
  fixtures: QaMatrixFixtures = qaMatrixFixtures(),
): readonly QaMatrixCombination[] {
  const combinations: QaMatrixCombination[] = [];
  for (const strategy of fixtures.strategies) {
    for (const list of fixtures.lists) {
      for (const config of fixtures.configs) {
        combinations.push({
          label: qaMatrixRunLabel(strategy.id, list.id, config.id),
          strategy,
          list,
          config,
        });
      }
    }
  }
  return combinations;
}

/**
 * Whether a persisted `BacktestRun` came from the matrix, decided from the run's own denormalized
 * `strategyName` / `stockListName` columns.
 *
 * This is the **retention predicate** the future runner cleans with. It is deliberately expressed
 * against columns a run keeps forever — a run's snapshot is immutable and its `strategyId` /
 * `stockListId` are nulled when a fixture is deleted, so neither foreign key can be trusted to
 * identify an old matrix run. Both names must be in the reserved namespace, so an ordinary backtest
 * a developer ran by hand can never match, and neither can a run that used a matrix strategy
 * against a personal list.
 */
export function isQaMatrixRun(run: {
  readonly strategyName: string;
  readonly stockListName: string;
}): boolean {
  return (
    run.strategyName.startsWith(`${QA_MATRIX_NAME_PREFIX}S`) &&
    run.stockListName.startsWith(`${QA_MATRIX_NAME_PREFIX}L`)
  );
}

/**
 * The handful of combinations a later Playwright acceptance suite should drive through the browser.
 *
 * The thousand-run matrix is backend work: it is an API-level exhaustive sweep whose value is
 * arithmetic, and a browser has nothing to add to it while multiplying its cost. What a browser is
 * uniquely able to check is that a real user can select these fixtures, submit them, watch a run
 * progress and read its result — so the Playwright suite takes one short run, one contribution-driven
 * run, and one large single-slot run, and nothing more.
 *
 * Ordered from cheapest to most expensive, so a suite can take a prefix of it.
 */
export const QA_MATRIX_PLAYWRIGHT_SAMPLE: readonly {
  readonly strategyId: string;
  readonly listId: string;
  readonly configId: string;
  readonly reason: string;
}[] = [
  {
    strategyId: "S01",
    listId: "L01",
    configId: "C04",
    reason:
      "One security, one year, one BUY level: the fastest complete submit-run-read journey in the matrix.",
  },
  {
    strategyId: "S04",
    listId: "L05",
    configId: "C05",
    reason:
      "Mixed FULL/CUSTOM membership with monthly contributions and a multi-level ladder: the browser " +
      "path where buy windows and deposits are both visible in the result.",
  },
  {
    strategyId: "S10",
    listId: "L08",
    configId: "C09",
    reason:
      "Thirty securities competing for a single position slot: the run whose trade list and holdings " +
      "panel are worth reading in a real browser.",
  },
];
