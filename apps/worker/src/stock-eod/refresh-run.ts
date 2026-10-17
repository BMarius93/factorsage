import type { LocalDate, Security } from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  derivedStateCaughtUp,
  type CanonicalStockDataService,
  type EodFinalityPolicy,
  type FinalizedSession,
  type StockRefreshState,
} from "@intrinsic/stock-data";
import { mapWithConcurrency } from "../shared/concurrency.js";
import type { ActiveMonitor } from "../monitor/monitor-repository.js";
import { stockEodUniverse, type StockEodTarget } from "./universe.js";

/**
 * One pass of the stock EOD preparation (`docs/decisions/monitor-eod-v2-proposal.md` §3).
 *
 * For the newest finalized session — resolved **once** for the whole run, so every security is held
 * to the same one — and the deduplicated union of securities every running Monitor watches:
 *
 * 1. ask PostgreSQL alone whether the security already holds the session, read after it became
 *    final, with its history loaded from the product horizon (`stockRefreshState`);
 * 2. if it does, ingest only what its operands read beyond prices, each behind its own freshness;
 * 3. if it does not, prepare it through the canonical loader (`refreshStockTail`): coverage gaps,
 *    one bounded tail read, statements only when an operand reads them.
 *
 * It owns the provider work Monitor evaluation must never do, and nothing else: it decides no
 * Signal and writes no Monitor state. Each security is isolated — one that fails is logged and
 * retried on a later run while the rest proceed — and the run fails as a whole only when every
 * security it attempted failed, which is what an outage of PostgreSQL, Redis or the provider looks
 * like. No security starts after `runBudgetMs` or once the lease is lost; the rest are `DEFERRED`,
 * and the loop resumes the run after `followUpMs` instead of a full interval.
 */

/** The slice of the canonical loader a run uses. */
export type StockEodService = Pick<
  CanonicalStockDataService,
  | "findSecuritiesByIds"
  | "stockRefreshState"
  | "refreshStockTail"
  | "prepareStockOperands"
  | "evaluationHistoryStart"
>;

/** Where the run learns which Monitors are running. `PrismaMonitorRepository` in production. */
export type StockEodMonitorSource = {
  listActiveMonitors(): Promise<ActiveMonitor[]>;
};

export type StockEodOutcome =
  /** The session's bar is stored and proven final. */
  | "READY"
  /** The provider has not published the session yet; asked again on the retry spacing. */
  | "AWAITING_PUBLICATION"
  /** Still missing past the give-up bound: the security did not trade the session. */
  | "NOT_PUBLISHED"
  /** Tails are frozen in this environment and storage does not hold the session. */
  | "FROZEN"
  | "FAILED"
  /** Not reached inside the budget, or the run was asked to stop. */
  | "DEFERRED"
  /** Failed recently while others succeeded; waiting out its backoff. */
  | "BACKING_OFF";

export type StockEodSecurityOutcome = {
  securityId: string;
  symbol: string;
  outcome: StockEodOutcome;
  /** True when the canonical loader was entered for it this run. */
  prepared: boolean;
  latestVerifiedBar?: LocalDate;
  durationMs: number;
  error?: string;
};

export type StockEodRefreshSummary = {
  runSequence: number;
  expectedSession: LocalDate;
  calendar: FinalizedSession["calendar"];
  /** Distinct securities the running Monitors watch on that session. */
  universe: number;
  outcomes: StockEodSecurityOutcome[];
  /** Provider requests this run made, every page and retry counted at the gate's observer. */
  providerReads: number;
  failed: number;
  deferred: number;
  durationMs: number;
};

export type StockEodRefreshRunOptions = {
  policy: Pick<EodFinalityPolicy, "expectedSession" | "decide" | "sessionRetryMs">;
  runBudgetMs: number;
  securityConcurrency: number;
  followUpMs: number;
  /** The process's provider request count, read before and after the run. */
  providerRequests: () => number;
  now?: () => Date;
};

/** A security failing alone waits this long at most before it is attempted again. */
export const MAX_SECURITY_BACKOFF_MS = 6 * 60 * 60_000;

/** Raised when every security a run attempted failed: the run itself failed and backs off. */
export class StockEodRefreshFailedError extends Error {
  constructor(readonly summary: StockEodRefreshSummary) {
    super(
      `Every security attempted in stock EOD run ${summary.runSequence} failed (${summary.failed})`,
    );
    this.name = "StockEodRefreshFailedError";
  }
}

export class StockEodRefreshRun {
  private readonly now: () => Date;
  /**
   * Per-security backoff, in this process. Losing it on a restart costs at most one early attempt
   * per security; the singleton claim means only one process prepares at a time.
   */
  private readonly backoff = new Map<string, { until: number; attempts: number }>();

  constructor(
    private readonly service: StockEodService,
    private readonly monitors: StockEodMonitorSource,
    private readonly logger: StructuredLogger,
    private readonly options: StockEodRefreshRunOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(
    runSequence: number,
    aborted: () => boolean,
  ): Promise<StockEodRefreshSummary> {
    const started = Date.now();
    const readsBefore = this.options.providerRequests();
    const expected = await this.options.policy.expectedSession();
    if (expected.calendar === "WEEKDAYS") {
      this.logger.warn({
        event: "stock-eod.calendar-unavailable",
        runSequence,
        expectedSession: expected.session,
      });
    }

    const { targets, invalidMonitorIds } = stockEodUniverse(
      await this.monitors.listActiveMonitors(),
      expected.session,
    );
    if (invalidMonitorIds.length > 0) {
      this.logger.error({
        event: "stock-eod.monitor-definition.invalid",
        runSequence,
        monitorIds: invalidMonitorIds,
      });
    }
    const securities = new Map(
      (
        await this.service.findSecuritiesByIds(targets.map((t) => t.securityId))
      ).map((security) => [security.id, security]),
    );

    const outcomes: StockEodSecurityOutcome[] = new Array(targets.length);
    await mapWithConcurrency(
      targets,
      this.options.securityConcurrency,
      async (target, index) => {
        outcomes[index] = await this.prepareOne(
          target,
          securities.get(target.securityId),
          expected,
          runSequence,
          () => aborted() || Date.now() - started >= this.options.runBudgetMs,
        );
      },
    );

    const attempted = outcomes.filter(
      (item) => item.outcome !== "DEFERRED" && item.outcome !== "BACKING_OFF",
    );
    const everyAttemptFailed =
      attempted.length > 0 && attempted.every((item) => item.outcome === "FAILED");
    this.updateBackoff(attempted, everyAttemptFailed);
    const summary: StockEodRefreshSummary = {
      runSequence,
      expectedSession: expected.session,
      calendar: expected.calendar,
      universe: targets.length,
      outcomes,
      providerReads: this.options.providerRequests() - readsBefore,
      failed: outcomes.filter((item) => item.outcome === "FAILED").length,
      deferred: outcomes.filter((item) => item.outcome === "DEFERRED").length,
      durationMs: Date.now() - started,
    };
    this.logger.info({
      event: "stock-eod.run.summary",
      runSequence,
      expectedSession: summary.expectedSession,
      calendar: summary.calendar,
      universe: summary.universe,
      prepared: outcomes.filter((item) => item.prepared).length,
      providerReads: summary.providerReads,
      failed: summary.failed,
      deferred: summary.deferred,
      durationMs: summary.durationMs,
      outcomes: countBy(outcomes.map((item) => item.outcome)),
    });
    if (everyAttemptFailed) {
      throw new StockEodRefreshFailedError(summary);
    }
    return summary;
  }

  /** Resume promptly while securities are left over from the budget; otherwise the interval. */
  followUpMs(summary: StockEodRefreshSummary): number | undefined {
    return summary.deferred > 0 ? this.options.followUpMs : undefined;
  }

  private async prepareOne(
    target: StockEodTarget,
    security: Security | undefined,
    expected: FinalizedSession,
    runSequence: number,
    stop: () => boolean,
  ): Promise<StockEodSecurityOutcome> {
    const started = Date.now();
    const base = { securityId: target.securityId, symbol: target.symbol };
    if (stop()) {
      return { ...base, outcome: "DEFERRED", prepared: false, durationMs: 0 };
    }
    const waiting = this.backoff.get(target.securityId);
    if (waiting && waiting.until > this.now().getTime()) {
      return { ...base, outcome: "BACKING_OFF", prepared: false, durationMs: 0 };
    }
    if (!security) {
      // Removed from the catalog between the Monitor read and this one: nothing to prepare.
      return {
        ...base,
        outcome: "FAILED",
        prepared: false,
        durationMs: Date.now() - started,
        error: "Security not found in the catalog",
      };
    }
    try {
      const from = this.service.evaluationHistoryStart(security);
      const state = await this.service.stockRefreshState(security);
      const decision = this.options.policy.decide(state, expected);
      const historyLoaded =
        state.coverageStart !== undefined && state.coverageStart <= from;
      if (historyLoaded && decision.action === "SKIP" && derivedStateCaughtUp(state)) {
        // Nothing price-side to ask for: PostgreSQL already holds the session as read after it
        // became final, or has stopped asking for it. A derived state behind the verified bars is
        // not "nothing to do" (OPS-02): it is repaired by the call below, from PostgreSQL. Only
        // operand inputs keep their own freshness.
        if (target.operands.length > 0) {
          await this.service.prepareStockOperands(security, target.operands);
        }
        return {
          ...base,
          outcome: skipOutcome(decision.reason),
          prepared: false,
          ...(state.latestVerifiedBar
            ? { latestVerifiedBar: state.latestVerifiedBar }
            : {}),
          durationMs: Date.now() - started,
        };
      }
      const result = await this.service.refreshStockTail(security, {
        expectedSession: expected,
        from,
        fundamentals: target.readsStatements ? "if-stale" : "skip",
        operands: target.operands,
      });
      const outcome: StockEodSecurityOutcome = {
        ...base,
        outcome: result.status,
        prepared: true,
        ...(result.state.latestVerifiedBar
          ? { latestVerifiedBar: result.state.latestVerifiedBar }
          : {}),
        durationMs: Date.now() - started,
      };
      this.logger.debug({
        event: "stock-eod.security.prepared",
        runSequence,
        ...base,
        outcome: result.status,
        reason:
          decision.action === "REFRESH"
            ? decision.reason
            : historyLoaded
              ? "DERIVED_BEHIND"
              : "HISTORY_MISSING",
        expectedSession: expected.session,
        ...stateFields(result.state),
        durationMs: outcome.durationMs,
      });
      return outcome;
    } catch (err) {
      const durationMs = Date.now() - started;
      this.logger.warn({
        event: "stock-eod.security.failed",
        runSequence,
        ...base,
        expectedSession: expected.session,
        durationMs,
        err,
      });
      return {
        ...base,
        outcome: "FAILED",
        prepared: true,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * A security that fails while others succeed backs off, doubling from the retry spacing up to
   * six hours. When every attempt fails together the cause is shared and the run's own backoff
   * spaces the retry, so a recovered outage is not then held up per security.
   */
  private updateBackoff(
    attempted: readonly StockEodSecurityOutcome[],
    everyAttemptFailed: boolean,
  ): void {
    const now = this.now().getTime();
    for (const item of attempted) {
      if (item.outcome !== "FAILED") {
        this.backoff.delete(item.securityId);
        continue;
      }
      if (everyAttemptFailed) {
        continue;
      }
      const attempts = (this.backoff.get(item.securityId)?.attempts ?? 0) + 1;
      const delay = Math.min(
        this.options.policy.sessionRetryMs * 2 ** Math.min(attempts - 1, 16),
        MAX_SECURITY_BACKOFF_MS,
      );
      this.backoff.set(item.securityId, { until: now + delay, attempts });
    }
  }
}

function skipOutcome(
  reason: "UP_TO_DATE" | "RECENTLY_ASKED" | "SESSION_NOT_PUBLISHED",
): StockEodOutcome {
  return reason === "UP_TO_DATE"
    ? "READY"
    : reason === "SESSION_NOT_PUBLISHED"
      ? "NOT_PUBLISHED"
      : "AWAITING_PUBLICATION";
}

function stateFields(state: StockRefreshState) {
  return {
    latestBar: state.latestBar,
    latestVerifiedBar: state.latestVerifiedBar,
    verifiedThrough: state.verifiedThrough,
    derivedThrough: state.derivedThrough,
    basisGeneration: state.priceBasisGeneration,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
