import { getEodFinalityConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { createLogger } from "@intrinsic/observability";
import { EodFinalityPolicy, type TradingCalendar } from "@intrinsic/stock-data";
import { createMonitorRuntime } from "./composition.js";
import { MonitorEodEvaluation } from "./monitor-evaluation.js";

/**
 * One real Monitor EOD evaluation at a chosen past session, for the data-correctness audit
 * (`docs/data-correctness-audit/`).
 *
 * Everything is the production path — repository, readiness, PostgreSQL frame, reconstruction,
 * reducer, persistence — with the clock pinned after that session finalized, and the exchange
 * calendar read from the pinned SP500 series' own bars (the execution calendar).
 *
 * It refuses to run anywhere but the dedicated QA-matrix database.
 *
 * `tsx src/monitor/data-correctness-scan.ts --as-of YYYY-MM-DD`
 */
loadRootEnv();
const asOfArg = process.argv.indexOf("--as-of");
const asOf = asOfArg >= 0 ? process.argv[asOfArg + 1] : undefined;
if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  throw new Error("Usage: data-correctness-scan.ts --as-of YYYY-MM-DD");
}
const databaseUrl = process.env.DATABASE_URL ?? "";
if (
  process.env.INTRINSIC_QA_MATRIX_DATABASE_ACTIVE !== "true" ||
  !/matrix/.test(new URL(databaseUrl).pathname)
) {
  throw new Error(
    "The audit scan runs only against the QA-matrix database (INTRINSIC_QA_MATRIX_DATABASE_ACTIVE).",
  );
}

const logger = createLogger({
  service: "worker",
  level: "warn",
  environment: "development",
  base: { component: "monitor", workerId: "data-correctness-audit" },
});
const runtime = createMonitorRuntime(logger);
const prisma = new PrismaClient();

try {
  const sessions = new Set(
    (
      await prisma.$queryRawUnsafe<{ date: string }[]>(
        `select b.date::text as date from "BenchmarkDailyPrice" b join "BenchmarkSeries" s on s.id = b."seriesId"
           join "Benchmark" k on k.id = s."benchmarkId" where k.code = 'SP500'`,
      )
    ).map((row) => row.date),
  );
  if (!sessions.has(asOf)) {
    throw new Error(`${asOf} is not a session of the execution calendar`);
  }
  const calendar: TradingCalendar = {
    async isTradingSession(_exchange: string, date: string): Promise<boolean> {
      return sessions.has(date);
    },
  };
  // After the session's close plus the publication delay in either daylight-saving regime, so the
  // pass evaluates exactly that finalized session from the stored closes — the production path.
  const clock = new Date(`${asOf}T23:00:00.000Z`);
  const cycle = new MonitorEodEvaluation(
    runtime.monitors,
    runtime.data,
    new EodFinalityPolicy({
      calendar,
      publicationDelayMs: getEodFinalityConfig().publicationDelayMs,
      now: () => clock,
    }),
    logger,
    {
      securityConcurrency: 4,
      lateRecoveryMs: getEodFinalityConfig().lateRecoveryMs,
      now: () => clock,
    },
    runtime.etfContexts,
  );
  const summary = await cycle.run(Date.now());
  process.stdout.write(`${JSON.stringify({ asOf, summary })}\n`);
} finally {
  await prisma.$disconnect();
  await runtime.close();
}
