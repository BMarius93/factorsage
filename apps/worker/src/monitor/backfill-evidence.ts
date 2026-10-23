import {
  getEodFinalityConfig,
  getWorkerConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { eodCutoffDate } from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import { createMonitorRuntime } from "./composition.js";
import { LegacyEvidenceBackfill } from "./legacy-evidence.js";

/**
 * `pnpm monitors:backfill-evidence [--apply]` — the legacy-evidence operator step of the Monitor
 * rolling-window release (`docs/decisions/monitor-eod-v2.md` §12.6).
 *
 * Verifies every Monitor change inside the Dashboard's rolling 30-day window that was recorded
 * before evidence existed, and prints how many are recoverable and how many stay excluded, by
 * reason. Nothing is written without `--apply`; with it, each verified change receives its evidence
 * once, stamped as reconstructed. Reads PostgreSQL only — no provider request — and is safe to run
 * again or beside a running worker.
 */
loadRootEnv();
const apply = process.argv.includes("--apply");
const appConfig = getWorkerConfig();
const logger = createLogger({
  service: "worker",
  level: appConfig.logLevel,
  environment: appConfig.environment,
  base: { component: "monitor" },
});

const runtime = createMonitorRuntime(logger);
try {
  const now = new Date();
  const report = await new LegacyEvidenceBackfill(
    runtime.prisma,
    runtime.data,
    logger,
    {
      latest: eodCutoffDate(now, getEodFinalityConfig().publicationDelayMs),
      apply,
      now: () => now,
    },
  ).run();
  const recoverable = report.outcomes.RECONSTRUCTED;
  process.stdout.write(
    [
      `Legacy Monitor events since ${report.windowStart}: ${report.candidates}`,
      `  recoverable (evidence verified): ${recoverable}`,
      `  excluded from the Dashboard: ${report.candidates - recoverable}`,
      ...Object.entries(report.outcomes)
        .filter(([outcome, count]) => outcome !== "RECONSTRUCTED" && count > 0)
        .map(([outcome, count]) => `    ${outcome}: ${count}`),
      apply
        ? `  evidence written: ${report.written}`
        : "  dry run: nothing written (pass --apply to record the verified evidence)",
      "",
    ].join("\n"),
  );
} catch (err) {
  logger.fatal({ event: "monitor.legacy-evidence.failed", err });
  process.exitCode = 1;
} finally {
  await runtime.close();
}
