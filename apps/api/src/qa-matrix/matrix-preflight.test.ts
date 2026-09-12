import { qaMatrixFixtures } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./matrix-paths";
import {
  formatPreflightReport,
  runQaMatrixPreflight,
  type PreflightCheck,
  type QaMatrixPreflightReport,
} from "./matrix-preflight";
import {
  MATRIX_ENVIRONMENT,
  stubPrisma,
  weekdays,
  type StubOptions,
} from "./matrix-preflight.test-helper";

/**
 * The gate that decides whether a thousand backtests may start.
 *
 * Every failure it exists to catch produces a sweep that *looks* successful — a calendar covering
 * six of thirty requested years, a security whose history starts after the run, a dataset revision
 * the loader will quietly rebuild from the provider mid-sweep. None of those raises an error at run
 * time; they change the numbers and say nothing. So each one is presented here deliberately.
 */
const AS_OF = "2026-09-09";
const FULL_CALENDAR = weekdays("1996-01-02", "2026-09-08");
const FIXTURES = qaMatrixFixtures(AS_OF, FULL_CALENDAR);

async function preflight(
  options: StubOptions = {},
): Promise<QaMatrixPreflightReport> {
  return runQaMatrixPreflight({
    prisma: stubPrisma(FIXTURES, { calendarDates: FULL_CALENDAR, ...options }),
    environment: MATRIX_ENVIRONMENT,
    fixtures: FIXTURES,
    asOfDate: AS_OF,
    ownerEmail: "qa-user@factorsage.test",
    concurrency: 1,
    today: AS_OF,
    repositoryRoot: repositoryRoot(),
  });
}

const check = (
  report: QaMatrixPreflightReport,
  id: string,
): PreflightCheck | undefined => report.checks.find((entry) => entry.id === id);

describe("a healthy matrix environment", () => {
  it("is green, and says what it checked", async () => {
    const report = await preflight();
    const failures = report.checks.filter((entry) => entry.status === "FAIL");
    expect(
      failures.map((entry) => `${entry.id}: ${entry.problems?.join("; ")}`),
    ).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
  });

  it("covers every check the matrix specification requires", async () => {
    const report = await preflight();
    expect(report.checks.map((entry) => entry.id).sort()).toEqual(
      [
        "cartesian-product",
        "comparison-benchmark",
        "database-identity",
        "dataset-revisions",
        "derived-state-coverage",
        "environment-safety",
        "execution-calendar",
        "fixture-completeness",
        "fixture-configs",
        "fixture-lists",
        "fixture-strategies",
        "fundamentals-coverage",
        "migrations",
        "missing-symbols",
        "product-horizon",
        "qa-owner",
        "security-coverage",
      ].sort(),
    );
  });

  it("confirms the ten-by-ten-by-ten product is a thousand unique combinations", async () => {
    const report = await preflight();
    expect(check(report, "cartesian-product")?.facts?.combinations).toBe(1_000);
    expect(check(report, "fixture-strategies")?.facts?.found).toBe(10);
    expect(check(report, "fixture-lists")?.facts?.found).toBe(10);
    expect(check(report, "fixture-configs")?.facts?.found).toBe(10);
  });

  it("renders a report a developer can read", async () => {
    const text = formatPreflightReport(await preflight());
    expect(text).toContain("QA MATRIX PREFLIGHT");
    expect(text).toContain("intrinsic_value_matrix");
    expect(text).toContain("PREFLIGHT GREEN");
  });
});

describe("preflight rejection", () => {
  it("refuses the lightweight test dataset's short execution calendar", async () => {
    // This is the failure the whole environment design exists to prevent. A calendar that starts in
    // 2020 does not fail a thirty-year run — it silently makes it a six-year one whose first
    // simulated date, return base and contribution schedule are all different from the ones asked
    // for, and whose report would call that success.
    const report = await preflight({
      calendarDates: weekdays("2020-01-02", "2026-09-04"),
    });
    expect(report.ok).toBe(false);
    const calendar = check(report, "execution-calendar");
    expect(calendar?.status).toBe("FAIL");
    expect(calendar?.problems?.join(" ")).toContain("the calendar only begins");
  });

  it("refuses a database with no execution-calendar bars at all", async () => {
    const report = await preflight({ calendarDates: [] });
    expect(check(report, "execution-calendar")?.status).toBe("FAIL");
    expect(report.ok).toBe(false);
  });

  it("refuses a missing QA fixture owner", async () => {
    const report = await preflight({ noOwner: true });
    expect(check(report, "qa-owner")?.status).toBe("FAIL");
    expect(report.ok).toBe(false);
  });

  it("refuses an owner whose plan cannot run the sweep's concurrency", async () => {
    // The runner submits through the product's real entitlement-enforced path, so the owner's
    // plan is an input to whether a thousand cases can run at all. Discovering that on case one,
    // fifteen minutes in, is exactly what the preflight exists to prevent.
    const report = await runQaMatrixPreflight({
      prisma: stubPrisma(FIXTURES, {
        calendarDates: FULL_CALENDAR,
        ownerPlan: "PRO",
        ownerRole: "USER",
      }),
      environment: MATRIX_ENVIRONMENT,
      fixtures: FIXTURES,
      asOfDate: AS_OF,
      ownerEmail: "qa-user@factorsage.test",
      concurrency: 4,
      today: AS_OF,
      repositoryRoot: repositoryRoot(),
    });

    const owner = check(report, "qa-owner");
    expect(owner?.status).toBe("FAIL");
    expect(owner?.problems?.join(" ")).toContain("2 backtests at once");
    expect(owner?.problems?.join(" ")).toContain("QA_ADMIN");
    expect(report.ok).toBe(false);
  });

  it("passes for the administrator persona the fixtures are meant to be owned by", async () => {
    const report = await runQaMatrixPreflight({
      prisma: stubPrisma(FIXTURES, {
        calendarDates: FULL_CALENDAR,
        ownerPlan: "FREE",
        ownerRole: "ADMIN",
      }),
      environment: MATRIX_ENVIRONMENT,
      fixtures: FIXTURES,
      asOfDate: AS_OF,
      ownerEmail: "qa-user@factorsage.test",
      concurrency: 8,
      today: AS_OF,
      repositoryRoot: repositoryRoot(),
    });

    const owner = check(report, "qa-owner");
    // `ADMIN_ENTITLEMENTS` lifts capacity from the role, never from the plan — which is still FREE.
    expect(owner?.status).toBe("PASS");
    expect(owner?.facts?.maxConcurrentRuns).toBeNull();
    expect(owner?.facts?.plan).toBe("FREE");
  });

  it("refuses nine strategies where there should be ten", async () => {
    const report = await preflight({ missingStrategies: ["S07"] });
    const strategies = check(report, "fixture-strategies");
    expect(strategies?.status).toBe("FAIL");
    expect(strategies?.facts?.found).toBe(9);
    expect(strategies?.problems?.join(" ")).toContain("S07");
  });

  it("refuses nine lists where there should be ten", async () => {
    const report = await preflight({ missingLists: ["L04"] });
    expect(check(report, "fixture-lists")?.status).toBe("FAIL");
  });

  it("refuses a persisted strategy whose definition has drifted from the fixture", async () => {
    // Counting rows would prove only that ten things exist. The definition each row carries is what
    // a run snapshots and executes.
    const report = await preflight({ driftedStrategy: "S04" });
    const strategies = check(report, "fixture-strategies");
    expect(strategies?.status).toBe("FAIL");
    expect(strategies?.problems?.join(" ")).toContain("re-seed the matrix");
  });

  it("refuses a list member with no catalog identity", async () => {
    const report = await preflight({ missingSymbols: ["NVDA"] });
    expect(check(report, "missing-symbols")?.status).toBe("FAIL");
    expect(check(report, "missing-symbols")?.problems?.join(" ")).toContain(
      "NVDA",
    );
  });

  it("refuses a security whose price history starts after a run does", async () => {
    const report = await preflight({ latePrices: { KO: "2015-01-02" } });
    const coverage = check(report, "security-coverage");
    expect(coverage?.status).toBe("FAIL");
    expect(coverage?.problems?.join(" ")).toContain("KO");
  });

  it("accepts a later listing, because pre-listing data must never be fabricated", async () => {
    // `MRNA` legitimately has no history before 2018. That is correct data, not a coverage gap.
    const report = await preflight();
    expect(check(report, "security-coverage")?.status).toBe("PASS");
  });

  it("refuses a security with no derived state", async () => {
    const report = await preflight({ noDerivedState: ["MSFT"] });
    const derived = check(report, "derived-state-coverage");
    expect(derived?.status).toBe("FAIL");
    expect(derived?.problems?.join(" ")).toContain("MSFT");
  });

  it("refuses a stale derived-state revision the loader would rebuild mid-sweep", async () => {
    const report = await preflight({ staleDerivedVariant: true });
    const revisions = check(report, "dataset-revisions");
    expect(revisions?.status).toBe("FAIL");
    expect(revisions?.problems?.join(" ")).toContain(
      "recalculated during the sweep",
    );
  });

  it("refuses an unapplied migration", async () => {
    const report = await preflight({
      unappliedMigrations: [
        "20260909093000_add_backtest_absolute_comparison_values",
      ],
    });
    expect(check(report, "migrations")?.status).toBe("FAIL");
  });

  it("refuses a connection that landed in a different database than configured", async () => {
    const report = await preflight({ connectedDatabase: "intrinsic_value" });
    expect(check(report, "database-identity")?.status).toBe("FAIL");
  });

  it("reports every problem at once rather than stopping at the first", async () => {
    const report = await preflight({
      missingStrategies: ["S02"],
      missingLists: ["L03"],
      noDerivedState: ["IBM"],
    });
    expect(report.failed).toBeGreaterThanOrEqual(3);
    const text = formatPreflightReport(report);
    expect(text).toContain("PREFLIGHT FAILED");
  });
});

describe("fundamentals", () => {
  it("fails only when no security at all can be valued", async () => {
    const symbols = FIXTURES.lists.flatMap((list) =>
      list.members.map((member) => member.symbol),
    );
    const report = await preflight({ noStatements: symbols });
    const fundamentals = check(report, "fundamentals-coverage");
    expect(fundamentals?.status).toBe("FAIL");
    expect(fundamentals?.problems?.join(" ")).toContain("NOT_EVALUABLE");
  });

  it("warns rather than fails when some securities have no statements", async () => {
    // An intrinsic value that cannot be computed is NOT_EVALUABLE, which is correct behaviour and
    // is exactly what `S09`'s deliberate probe exercises.
    const report = await preflight({ noStatements: ["MRNA", "V"] });
    const fundamentals = check(report, "fundamentals-coverage");
    expect(fundamentals?.status).toBe("WARN");
    expect(report.ok).toBe(true);
    expect(report.warned).toBeGreaterThan(0);
  });
});

describe("environment safety, as a reported check", () => {
  const withEnvironment = async (
    environment: Partial<typeof MATRIX_ENVIRONMENT>,
  ): Promise<QaMatrixPreflightReport> =>
    runQaMatrixPreflight({
      prisma: stubPrisma(FIXTURES, { calendarDates: FULL_CALENDAR }),
      environment: { ...MATRIX_ENVIRONMENT, ...environment },
      fixtures: FIXTURES,
      asOfDate: AS_OF,
      ownerEmail: "qa-user@factorsage.test",
      concurrency: 1,
      today: AS_OF,
      repositoryRoot: repositoryRoot(),
    });

  it("compares against the connections as they were before the process was pointed at the matrix", async () => {
    // `useMatrixDatabase` overwrites DATABASE_URL and REDIS_URL in place. A check that re-read them
    // would compare the matrix with itself and report an isolation it never verified.
    const report = await withEnvironment({});
    expect(check(report, "environment-safety")?.status).toBe("PASS");
    expect(
      check(report, "environment-safety")?.facts?.developmentDatabase,
    ).toContain("intrinsic_value");
  });

  it("fails when the matrix Redis shares the development stack's logical database", async () => {
    const report = await withEnvironment({
      developmentRedisUrl: "redis://localhost:6379/3",
    });
    const safety = check(report, "environment-safety");
    expect(safety?.status).toBe("FAIL");
    expect(safety?.problems?.join(" ")).toContain("would be shared");
  });

  it("fails when the matrix database is the development or the test database", async () => {
    const asDevelopment = await withEnvironment({
      developmentDatabaseUrl: MATRIX_ENVIRONMENT.databaseUrl,
    });
    expect(
      check(asDevelopment, "environment-safety")?.problems?.join(" "),
    ).toContain("equals DATABASE_URL");
    const asTest = await withEnvironment({
      testDatabaseUrl: MATRIX_ENVIRONMENT.databaseUrl,
    });
    expect(check(asTest, "environment-safety")?.problems?.join(" ")).toContain(
      "equals TEST_DATABASE_URL",
    );
  });
});

describe("a matrix clock that has drifted behind the selectable horizon", () => {
  /**
   * The failure this exists for was observed, not imagined.
   *
   * A sweep pinned to `2026-09-09` and executed on `2026-09-10` loaded 7,546 execution dates
   * instead of 7,547. `CanonicalStockDataService.projectionRange` clips every projection to
   * `[today - STOCK_HISTORY_YEARS, today]` from the **real** clock and does it silently, so the
   * three configurations that start exactly on the product horizon lost their first session — the
   * very boundary they exist to exercise — and every thirty-year run in the matrix was a day short
   * with nothing on screen to say so.
   *
   * Pinning the clock is right; running a pin that has aged past the horizon is not.
   */
  it("refuses a pinned clock older than the loader's own horizon", async () => {
    const report = await runQaMatrixPreflight({
      prisma: stubPrisma(FIXTURES, { calendarDates: FULL_CALENDAR }),
      environment: MATRIX_ENVIRONMENT,
      fixtures: FIXTURES,
      asOfDate: AS_OF,
      ownerEmail: "qa-user@factorsage.test",
      concurrency: 1,
      // One day later than the pin: the horizon has moved and the pin has not.
      today: "2026-09-10",
      repositoryRoot: repositoryRoot(),
    });
    const horizon = check(report, "product-horizon");
    expect(horizon?.status).toBe("FAIL");
    expect(horizon?.problems?.join(" ")).toContain("drifted behind it");
    expect(horizon?.problems?.join(" ")).toContain(
      "QA_MATRIX_AS_OF_DATE=2026-09-10",
    );
    expect(report.ok).toBe(false);
  });

  it("accepts a clock that is the current date", async () => {
    const report = await runQaMatrixPreflight({
      prisma: stubPrisma(FIXTURES, { calendarDates: FULL_CALENDAR }),
      environment: MATRIX_ENVIRONMENT,
      fixtures: FIXTURES,
      asOfDate: AS_OF,
      ownerEmail: "qa-user@factorsage.test",
      concurrency: 1,
      today: AS_OF,
      repositoryRoot: repositoryRoot(),
    });
    expect(check(report, "product-horizon")?.status).toBe("PASS");
  });
});
