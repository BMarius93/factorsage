import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  getStockEodWorkerConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import { MarketDataRefreshLoop } from "../market-data/refresh-loop.js";
import { createStockEodRuntime } from "./composition.js";
import {
  StockEodRefreshRun,
  type StockEodOutcome,
} from "./refresh-run.js";

/**
 * `pnpm stock-eod:refresh-once` — run one stock EOD preparation now, through the normal claim.
 *
 * An operator command: it takes the same singleton claim a worker child does, so it never runs
 * beside a preparation already in flight. It prints each watched security's outcome and exits
 * non-zero when the run did not complete or a security is left FAILED, DEFERRED or BACKING_OFF. A
 * security still AWAITING_PUBLICATION is normal for a while after the close, and not a failure.
 */
const UNHEALTHY_OUTCOMES = new Set<StockEodOutcome>([
  "FAILED",
  "DEFERRED",
  "BACKING_OFF",
]);

loadRootEnv();
const appConfig = getWorkerConfig();
const config = getStockEodWorkerConfig();
const workerId = `stock-eod-cli-${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "stock-eod", workerId },
});

const runtime = createStockEodRuntime(logger);
try {
  await runtime.schedule.ensureSchedule(new Date());
  await runtime.schedule.requestImmediateRun(new Date());
  const work = new StockEodRefreshRun(runtime.stockData, runtime.monitors, logger, {
    policy: runtime.policy,
    runBudgetMs: config.runBudgetMs,
    securityConcurrency: config.securityConcurrency,
    followUpMs: config.followUpMs,
    providerRequests: runtime.providerRequests,
  });
  const loop = new MarketDataRefreshLoop(
    runtime.schedule,
    {
      run: (runSequence, aborted) => work.run(runSequence, aborted),
      followUpMs: (summary) => work.followUpMs(summary),
    },
    logger,
    {
      workerId,
      refreshIntervalMs: config.refreshIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      leaseMs: config.leaseMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      retryBackoffMs: config.retryBackoffMs,
      events: "stock-eod.refresh",
      component: "stock-eod",
      jobIdPrefix: "stock-eod",
    },
  );
  const result = await loop.runOnce();
  if (result === null) {
    logger.warn({ event: "stock-eod.refresh-once.busy" });
    console.log(
      "A stock EOD run is already in flight; run this again once it finishes to see an outcome.",
    );
    process.exitCode = 1;
  } else if (result.outcome === "COMPLETED") {
    console.log(
      `Session ${result.summary.expectedSession} (${result.summary.calendar}), ` +
        `${result.summary.universe} securities, ${result.summary.providerReads} provider requests`,
    );
    for (const item of result.summary.outcomes) {
      console.log(
        `${item.outcome.padEnd(20)} ${item.symbol.padEnd(8)} ${item.latestVerifiedBar ?? "-"}` +
          (item.error ? ` — ${item.error}` : ""),
      );
    }
    const unhealthy = result.summary.outcomes.filter((item) =>
      UNHEALTHY_OUTCOMES.has(item.outcome),
    );
    logger.info({
      event: "stock-eod.refresh-once.completed",
      runSequence: result.summary.runSequence,
      providerReads: result.summary.providerReads,
      unhealthy: unhealthy.map((item) => `${item.symbol}:${item.outcome}`),
    });
    if (unhealthy.length > 0) {
      process.exitCode = 1;
    }
  } else {
    logger.error({ event: "stock-eod.refresh-once.failed", ...result });
    console.error(`The stock EOD run did not complete: ${result.outcome}`);
    process.exitCode = 1;
  }
} catch (err) {
  logger.fatal({ event: "stock-eod.refresh-once.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
}
