import { getAppConfig } from "@intrinsic/config";
import { createLogger } from "@intrinsic/observability";
import {
  LIVE_FMP_USAGE,
  LiveFmpUsageError,
  parseLiveFmpArguments,
} from "./fmp-live-arguments";
import { readLiveFmpStoredCoverage } from "./fmp-live-coverage";
import {
  LiveFmpEnvironmentError,
  assertLiveFmpChildEnvironment,
} from "./fmp-live-environment";
import { admitApprovedSecurities } from "./fmp-live-identity";
import {
  LIVE_FMP_EXIT_CODES,
  LIVE_FMP_REFUSED_EXIT_CODE,
  formatLiveFmpReport,
} from "./fmp-live-report";
import { executeLiveFmpRun } from "./fmp-live-run";
import { createLiveFmpRuntime } from "./fmp-live-runtime";

/**
 * The process that performs a live run. Started by `apps/api/src/fmp-live.ts` and by nothing else.
 *
 * It deliberately does **not** load the repository's `.env`: its environment is the allowlist the
 * launcher built, and reading the file here would hand this process every other credential a
 * developer keeps in it. It trusts nothing about how it was started — the command line is parsed
 * again and the opt-in, the target and the credential's shape are checked again — so running this
 * file directly gets no further than running the launcher would.
 */
async function main(): Promise<number> {
  let parsed;
  let environment;
  try {
    parsed = parseLiveFmpArguments(process.argv.slice(2));
    environment = assertLiveFmpChildEnvironment(process.env, {
      plan: parsed.plan,
    });
  } catch (error) {
    if (
      error instanceof LiveFmpUsageError ||
      error instanceof LiveFmpEnvironmentError
    ) {
      console.error(error.message);
      if (error instanceof LiveFmpUsageError) {
        console.error(LIVE_FMP_USAGE);
      }
      return LIVE_FMP_REFUSED_EXIT_CODE;
    }
    throw error;
  }

  const app = getAppConfig();
  const logger = createLogger({
    service: "api",
    level: app.logLevel,
    environment: app.environment,
    base: { component: "fmp-live" },
  });
  const runtime = createLiveFmpRuntime({
    symbols: parsed.symbols,
    budget: parsed.budget,
    runId: environment.runId,
    logger,
  });

  try {
    await runtime.prisma.$connect();
    const report = await executeLiveFmpRun({
      arguments: parsed,
      runId: environment.runId,
      databaseName: environment.target.databaseName,
      databaseHost: environment.target.databaseHost,
      dependencies: {
        readStoredCoverage: (securityId) =>
          readLiveFmpStoredCoverage(runtime.prisma, securityId),
        scope: runtime.scope,
        budget: runtime.budget,
        guard: runtime.guard,
        loaders: {
          stockData: runtime.stockData,
          alternativeData: runtime.alternativeData,
        },
        getSecurity: (symbol) => runtime.stockData.getSecurity(symbol),
        admit: (symbols) =>
          admitApprovedSecurities({
            store: runtime.store,
            cache: runtime.cache,
            provider: runtime.provider,
            symbols,
          }),
        productHistoryYears: runtime.productHistoryYears,
        alternativeDataMaxPages: runtime.alternativeDataMaxPages,
        maxRetries: runtime.maxRetries,
        logger,
      },
    });
    console.log(formatLiveFmpReport(report));
    return LIVE_FMP_EXIT_CODES[report.outcome];
  } catch (error) {
    // The message only: an error object can carry whatever its thrower attached.
    logger.error({ event: "fmp.live.run.crashed", err: error });
    console.error(
      `Live FMP hydration failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  } finally {
    await runtime.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
