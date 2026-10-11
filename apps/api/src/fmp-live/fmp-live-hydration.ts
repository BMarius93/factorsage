import {
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import type { DateRange, Security } from "@intrinsic/domain";
import {
  ALTERNATIVE_DATA_DOMAINS,
  type AlternativeDataDomain,
} from "@intrinsic/stock-data";
import type { LiveFmpResolvedSecurity } from "./fmp-live-identity";

/**
 * What "full history" does, one security at a time, and nothing else.
 *
 * There is no loading logic here. Each step is one call into a loader the product already runs:
 *
 * 1. **Core history** — `CanonicalStockDataService.getDailyDerivedState` over the whole product
 *    horizon. That is the read every Stock Details projection and `pnpm data:resync` make, and
 *    for a cold security it hydrates everything the product derives from: the profile, the
 *    retained daily prices (the horizon plus the derived-series warm-up), all six statement
 *    histories (three statements, quarterly and annual, the horizon plus the valuation warm-up),
 *    then the daily derived state — technicals, weekly state, intrinsic values and the Fundamental
 *    Metrics — in PostgreSQL and in Redis.
 * 2. **Valuation inputs** — `getDailyValuationRatio` for every ratio in the catalog over the same
 *    range: the Stock Details read, which refreshes the provider's split list and then computes
 *    the ratio from the stored closes, statements and splits. Nothing is stored for a ratio; it is
 *    read here because the split list has no other reader, and so that the report can say the
 *    ratios really are computable from what was hydrated.
 * 3. **Alternative data** — `CanonicalAlternativeDataService.ensureIngested` for both domains,
 *    which is what `pnpm data:alt-data:ingest` and a backtest's preparation call.
 *
 * Freshness is the loaders' own. A dataset inside its freshness window is not asked for again,
 * which is why a second run costs almost nothing, and the report says so per dataset rather than
 * pretending every run downloaded everything.
 *
 * The provider guard is consulted between steps. Once it has refused anything, nothing further is
 * started: the remaining steps are recorded as not run, never as done.
 */

export const LIVE_FMP_STEPS = [
  "CORE_HISTORY",
  "VALUATION_INPUTS",
  "ALTERNATIVE_DATA",
] as const;

export type LiveFmpStep = (typeof LIVE_FMP_STEPS)[number];

export type LiveFmpStepResult = {
  readonly step: LiveFmpStep;
  readonly status: "COMPLETED" | "FAILED" | "NOT_RUN";
  /** Why a step failed or was not run. An error's class and message, never a payload. */
  readonly detail?: string;
  readonly durationMs: number;
};

/** One valuation ratio as the read returned it: how many sessions carry a value, and which. */
export type LiveFmpRatioCoverage = {
  readonly ratio: ValuationRatioId;
  readonly sessions: number;
  readonly sessionsWithValue: number;
  readonly earliest: string | null;
  readonly latest: string | null;
};

export type LiveFmpSecurityResult = {
  readonly symbol: string;
  readonly securityId: string;
  readonly origin: LiveFmpResolvedSecurity["origin"];
  readonly steps: readonly LiveFmpStepResult[];
  readonly ratios: readonly LiveFmpRatioCoverage[];
  readonly durationMs: number;
};

export type LiveFmpLoaders = {
  readonly stockData: {
    getDailyDerivedState(
      symbol: string,
      range: DateRange,
    ): Promise<readonly unknown[]>;
    getDailyValuationRatio(
      symbol: string,
      ratioId: ValuationRatioId,
      range: DateRange,
    ): Promise<readonly { date: string; value?: number }[]>;
  };
  readonly alternativeData: {
    ensureIngested(
      security: Security,
      domains: readonly AlternativeDataDomain[],
    ): Promise<void>;
  };
};

export type LiveFmpHydrationInput = {
  readonly securities: readonly LiveFmpResolvedSecurity[];
  /** The whole product horizon, ending today. */
  readonly range: Required<DateRange>;
  readonly loaders: LiveFmpLoaders;
  /** Whether the provider guard has refused anything. Asked before every step. */
  readonly guardRefused: () => boolean;
  readonly now?: () => number;
};

/**
 * A failure, as far as a report may describe it: the error's class and message, the provider's
 * HTTP status when there was one, and the first machine-readable code in its chain of causes.
 *
 * The client reports every failure to reach the provider as "temporarily unavailable" and keeps
 * the reason as the error's cause. That reason is the difference between a certificate this
 * process does not trust (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`), a host it cannot reach
 * (`ECONNREFUSED`, `ENOTFOUND`) and a timeout — exactly what somebody validating a run in a new
 * environment needs to see. A code is a fixed word; a cause's message is not printed, because it
 * is free text this command did not write.
 */
export function describeLiveFmpError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }
  const details: string[] = [];
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && Number.isInteger(status)) {
    details.push(`HTTP ${status}`);
  }
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,59}$/.test(code)) {
      details.push(code);
      break;
    }
    current = current.cause;
  }
  return (
    `${error.name}: ${error.message}` +
    (details.length > 0 ? ` [${details.join(", ")}]` : "")
  );
}

export async function runLiveFmpHydration(
  input: LiveFmpHydrationInput,
): Promise<LiveFmpSecurityResult[]> {
  const now = input.now ?? Date.now;
  const results: LiveFmpSecurityResult[] = [];

  for (const { symbol, security, origin } of input.securities) {
    const securityStartedAt = now();
    const steps: LiveFmpStepResult[] = [];
    const ratios: LiveFmpRatioCoverage[] = [];

    const run = async (
      step: LiveFmpStep,
      blockedBy: string | null,
      work: () => Promise<void>,
    ): Promise<boolean> => {
      const reason = input.guardRefused()
        ? "the provider guard refused a request earlier in this run"
        : blockedBy;
      if (reason !== null) {
        steps.push({ step, status: "NOT_RUN", detail: reason, durationMs: 0 });
        return false;
      }
      const startedAt = now();
      try {
        await work();
        steps.push({
          step,
          status: "COMPLETED",
          durationMs: now() - startedAt,
        });
        return true;
      } catch (error) {
        steps.push({
          step,
          status: "FAILED",
          detail: describeLiveFmpError(error),
          durationMs: now() - startedAt,
        });
        return false;
      }
    };

    const core = await run("CORE_HISTORY", null, async () => {
      await input.loaders.stockData.getDailyDerivedState(symbol, input.range);
    });

    await run(
      "VALUATION_INPUTS",
      core
        ? null
        : "core history did not complete, and a ratio is read from it",
      async () => {
        for (const ratio of VALUATION_RATIO_IDS) {
          const points = await input.loaders.stockData.getDailyValuationRatio(
            symbol,
            ratio,
            input.range,
          );
          const valued = points.filter((point) => point.value !== undefined);
          ratios.push({
            ratio,
            sessions: points.length,
            sessionsWithValue: valued.length,
            earliest: valued[0]?.date ?? null,
            latest: valued.at(-1)?.date ?? null,
          });
        }
      },
    );

    // Independent of the price history: an ingest reads its own endpoints into its own tables.
    await run("ALTERNATIVE_DATA", null, async () => {
      await input.loaders.alternativeData.ensureIngested(
        security,
        ALTERNATIVE_DATA_DOMAINS,
      );
    });

    results.push({
      symbol,
      securityId: security.id,
      origin,
      steps,
      ratios,
      durationMs: now() - securityStartedAt,
    });
  }
  return results;
}
