import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { Security, SecurityId } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import type {
  CurrentObservation,
  TradingCalendar,
} from "@intrinsic/stock-data";
import { createMonitorRuntime } from "./composition.js";
import { MonitorCycle, type MonitorDataLoader } from "./monitor-cycle.js";

/**
 * One real Monitor cycle at a chosen past session, for the data-correctness audit
 * (`docs/data-correctness-audit/`).
 *
 * Everything is the production path — repository, reconstruction, frame projection, reducer,
 * persistence — except the two inputs a past session cannot get from the live provider:
 *
 * - the "live" quote is that session's persisted close, stamped 16:00 New York time;
 * - the exchange calendar is the pinned SP500 series' own bars (the execution calendar).
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
  const quotedAt = `${asOf}T20:00:00.000Z`;
  const data: MonitorDataLoader = Object.assign(
    Object.create(Object.getPrototypeOf(runtime.data)),
    runtime.data,
    {
      async getCurrentObservations(
        securities: readonly Security[],
      ): Promise<Map<SecurityId, CurrentObservation>> {
        const rows = await prisma.$queryRawUnsafe<
          { securityId: string; close: string }[]
        >(
          `select "securityId", close::text as close from "DailyPrice" where date = $1::date and "securityId" = any($2)`,
          asOf,
          securities.map((security) => security.id),
        );
        return new Map(
          rows.map((row) => [
            row.securityId,
            { price: Number(row.close), quotedAt },
          ]),
        );
      },
    },
  );
  const cycle = new MonitorCycle(runtime.monitors, data, calendar, logger, {
    symbolConcurrency: 4,
    quoteMaxAgeMs: 6 * 60 * 60 * 1000,
    now: () => new Date(`${asOf}T21:00:00.000Z`),
  });
  const summary = await cycle.run(Date.now());
  process.stdout.write(`${JSON.stringify({ asOf, summary })}\n`);
} finally {
  await prisma.$disconnect();
  await runtime.close();
}
