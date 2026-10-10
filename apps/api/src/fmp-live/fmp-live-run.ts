import type { DateRange, Security } from "@intrinsic/domain";
import {
  FmpProviderError,
  type FmpRequestBudget,
  type FmpSecurityScope,
} from "@intrinsic/fmp";
import type { StructuredLogger } from "@intrinsic/observability";
import { subtractYears } from "@intrinsic/stock-data";
import {
  LIVE_FMP_MAX_SECURITIES,
  type LiveFmpArguments,
} from "./fmp-live-arguments";
import type { LiveFmpStoredDataset } from "./fmp-live-coverage";
import type { LiveFmpRunGuard } from "./fmp-live-guard";
import {
  runLiveFmpHydration,
  type LiveFmpLoaders,
  type LiveFmpSecurityResult,
} from "./fmp-live-hydration";
import {
  resolveLiveFmpSecurities,
  type LiveFmpAdmissionOutcome,
  type LiveFmpResolution,
} from "./fmp-live-identity";
import { liveFmpRequestCeiling } from "./fmp-live-plan";
import { liveFmpOutcome, type LiveFmpRunReport } from "./fmp-live-report";

/**
 * One live run, from approved symbols to the report.
 *
 * Orchestration only: resolve, hydrate, read back what was stored, and decide the verdict. The
 * pieces it is handed are the runtime's (`fmp-live-runtime.ts`); taking them as an argument is
 * what lets the offline suites drive the whole run against a provider that is a function.
 */

export type LiveFmpRunDependencies = {
  /** What the database holds for one security: counts and date bounds, never row content. */
  readonly readStoredCoverage: (
    securityId: string,
  ) => Promise<readonly LiveFmpStoredDataset[]>;
  readonly scope: Pick<FmpSecurityScope, "bind">;
  readonly budget: Pick<FmpRequestBudget, "used">;
  readonly guard: Pick<LiveFmpRunGuard, "ledger" | "refused">;
  readonly loaders: LiveFmpLoaders;
  readonly getSecurity: (symbol: string) => Promise<Security>;
  /** Admits approved symbols the catalog does not hold. Never called for a plan. */
  readonly admit: (
    symbols: readonly string[],
  ) => Promise<readonly LiveFmpAdmissionOutcome[]>;
  readonly productHistoryYears: number;
  readonly alternativeDataMaxPages: number;
  readonly maxRetries: number;
  readonly logger: StructuredLogger;
  readonly now?: () => number;
};

/** The whole product horizon ending today: the range that makes the loader retain everything. */
export function liveFmpHistoryRange(
  productHistoryYears: number,
  today: string,
): Required<DateRange> {
  return { from: subtractYears(today, productHistoryYears), to: today };
}

export async function executeLiveFmpRun(input: {
  readonly arguments: LiveFmpArguments;
  readonly runId: string;
  readonly databaseName: string;
  readonly databaseHost: string;
  readonly dependencies: LiveFmpRunDependencies;
}): Promise<LiveFmpRunReport> {
  const { dependencies: deps, runId } = input;
  const { symbols, plan } = input.arguments;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const range = liveFmpHistoryRange(
    deps.productHistoryYears,
    new Date(startedAt).toISOString().slice(0, 10),
  );
  const ceiling = liveFmpRequestCeiling({
    securities: symbols.length,
    productHistoryYears: deps.productHistoryYears,
    alternativeDataMaxPages: deps.alternativeDataMaxPages,
    maxRetries: deps.maxRetries,
  });

  deps.logger.info({
    event: plan ? "fmp.live.plan.started" : "fmp.live.run.started",
    runId,
    symbols,
    budget: input.arguments.budget,
    database: input.databaseName,
  });

  let resolution: LiveFmpResolution;
  try {
    resolution = await resolveLiveFmpSecurities({
      symbols,
      scope: deps.scope,
      getSecurity: deps.getSecurity,
      ...(plan ? {} : { admit: deps.admit }),
    });
  } catch (error) {
    if (!(error instanceof FmpProviderError)) {
      throw error;
    }
    // The provider did not answer an identity request: a rejected key, an outage, or the guard
    // refusing it because the budget is already spent. That is a run that resolved nothing, and
    // it is reported as one — with its ledger — rather than as a crash.
    resolution = {
      resolved: [],
      unresolved: symbols.map((symbol) => ({
        symbol,
        reason: `resolution stopped before it was complete (${error.name}: ${error.message})`,
      })),
    };
  }
  const { resolved, unresolved } = resolution;

  let securities: LiveFmpSecurityResult[] = [];
  // All or nothing: a symbol that names no supported security is a mistake in the command, and
  // hydrating the rest would report a partial run as if it were the one that was asked for.
  if (!plan && unresolved.length === 0) {
    securities = await runLiveFmpHydration({
      securities: resolved,
      range,
      loaders: deps.loaders,
      guardRefused: () => deps.guard.refused,
      now,
    });
  }

  const stored = new Map<string, readonly LiveFmpStoredDataset[]>();
  if (!plan) {
    for (const { symbol, security } of resolved) {
      stored.set(symbol, await deps.readStoredCoverage(security.id));
    }
  }

  const ledger = deps.guard.ledger();
  const outcome = liveFmpOutcome({ plan, unresolved, securities, ledger });
  const report: LiveFmpRunReport = {
    runId,
    outcome,
    databaseName: input.databaseName,
    databaseHost: input.databaseHost,
    approved: symbols,
    maxSecurities: LIVE_FMP_MAX_SECURITIES,
    resolved,
    unresolved,
    securities,
    stored,
    ledger,
    budgetUsed: plan ? 0 : await deps.budget.used(),
    ceiling,
    productHistoryYears: deps.productHistoryYears,
    range,
    durationMs: now() - startedAt,
  };

  for (const refusal of ledger.refusals) {
    deps.logger.warn({ event: "fmp.live.request.refused", runId, ...refusal });
  }
  deps.logger.info({
    event: plan ? "fmp.live.plan.completed" : "fmp.live.run.completed",
    runId,
    outcome,
    securities: resolved.map(({ symbol, security }) => ({
      symbol,
      securityId: security.id,
    })),
    unresolved: unresolved.map(({ symbol }) => symbol),
    requestsSent: ledger.sent,
    requestsAuthorized: ledger.authorized,
    budget: ledger.budget,
    refusals: ledger.refusals.length,
    durationMs: report.durationMs,
  });
  return report;
}
