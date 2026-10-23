import type {
  DailyDerivedState,
  DailyPrice,
  DateRange,
  LocalDate,
  Security,
  SecurityId,
} from "@intrinsic/domain";
import {
  buildDailyDerivedState,
  EodFinalityPolicy,
  projectEvaluationFrame,
  WEEKDAY_TRADING_CALENDAR,
  type StockRefreshState,
} from "@intrinsic/stock-data";
import type {
  AlternativeDataFacts,
  EvaluationFrame,
  OperandKey,
} from "@intrinsic/strategy";
import type { MonitorEvaluationData } from "./monitor-evaluation.js";
import type { MonitorEvaluationRepository } from "./monitor-repository.js";

/**
 * The market-data boundary the Monitor EOD suites drive (`docs/decisions/monitor-eod-v2.md` §3).
 *
 * Bars live in memory as the stock EOD child would have left them in PostgreSQL: every stored bar
 * proven final, its derived row materialized by the canonical `buildDailyDerivedState`, and the frame
 * projected by the canonical `projectEvaluationFrame` — the same projection a backtest and the real
 * `readFinalizedEvaluationFrame` use. Only storage is replaced; the evaluation, the lifecycle, the
 * repository and the transactions are the production ones.
 *
 * It counts the frame reads, which is how "several Monitors share one read of a security" is
 * asserted without reaching into the evaluation's private state.
 */
export class EodFixtureData implements MonitorEvaluationData {
  readonly prices = new Map<SecurityId, DailyPrice[]>();
  /** Materialized rows per security; computed from the prices when not set. */
  readonly derived = new Map<SecurityId, DailyDerivedState[]>();
  /** Readiness ends here for a security whose newer bars are not proven final yet. */
  readonly verifiedThrough = new Map<SecurityId, LocalDate>();
  readonly frameReads: {
    securityId: SecurityId;
    range: Required<DateRange>;
    operands: readonly OperandKey[];
  }[] = [];
  /** Facts behind alternative-data operands, when a suite reads any. */
  alternativeData?: (input: {
    security: Security;
    operands: readonly OperandKey[];
    from: LocalDate;
    to: LocalDate;
  }) => Promise<ReadonlyMap<OperandKey, AlternativeDataFacts> | undefined>;
  /** Thrown by the next frame read of this security, then cleared. */
  readonly failNextRead = new Map<SecurityId, Error>();

  constructor(private readonly securities: Security[]) {}

  add(security: Security): void {
    if (!this.securities.some((entry) => entry.id === security.id)) {
      this.securities.push(security);
    }
  }

  /** Appends one finalized session's bar, replacing a bar already stored for that date. */
  addBar(securityId: SecurityId, date: LocalDate, close: number): void {
    const rows = (this.prices.get(securityId) ?? []).filter(
      (row) => row.date !== date,
    );
    rows.push({
      securityId,
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    });
    rows.sort((left, right) => left.date.localeCompare(right.date));
    this.prices.set(securityId, rows);
  }

  async findSecurities(ids: readonly SecurityId[]): Promise<Security[]> {
    return this.securities.filter((security) => ids.includes(security.id));
  }

  async stockRefreshState(security: Security): Promise<StockRefreshState> {
    const rows = this.prices.get(security.id) ?? [];
    const latestBar = rows.at(-1)?.date;
    const ceiling = this.verifiedThrough.get(security.id);
    const verified = rows.filter(
      (row) => ceiling === undefined || row.date <= ceiling,
    );
    const latestVerifiedBar = verified.at(-1)?.date;
    return {
      ...(rows[0]
        ? { coverageStart: rows[0].date, earliestBar: rows[0].date }
        : {}),
      ...(latestBar ? { latestBar, tailDate: latestBar } : {}),
      ...(latestVerifiedBar
        ? {
            latestVerifiedBar,
            verifiedThrough: latestVerifiedBar,
            derivedThrough: latestVerifiedBar,
            lastTailSyncAt: `${latestVerifiedBar}T23:30:00.000Z`,
          }
        : {}),
      priceBasisGeneration: 0,
    };
  }

  async readFinalizedEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<{ frame: EvaluationFrame; priceBasisGeneration: number }> {
    this.frameReads.push({ securityId: security.id, range, operands });
    const failure = this.failNextRead.get(security.id);
    if (failure) {
      this.failNextRead.delete(security.id);
      throw failure;
    }
    const all = this.prices.get(security.id) ?? [];
    const prices = all.filter((row) => row.date <= range.to);
    const derived = (
      this.derived.get(security.id) ?? buildDailyDerivedState({ prices: all })
    ).filter((row) => row.date <= range.to);
    const alternativeData = this.alternativeData
      ? await this.alternativeData({
          security,
          operands,
          from: prices[0]?.date ?? range.from,
          to: range.to,
        })
      : undefined;
    return {
      frame: projectEvaluationFrame({
        security,
        prices,
        derived,
        operands,
        periodStart: range.from,
        ...(alternativeData ? { alternativeData } : {}),
      }).frame,
      priceBasisGeneration: 0,
    };
  }

  reconstructionHistoryStart(security: Security): LocalDate {
    return this.prices.get(security.id)?.[0]?.date ?? "2000-01-03";
  }
}

/** Closes on consecutive weekdays ending on Friday 2026-02-27, so every driven session is later. */
export function longHistory(
  securityId: string,
  closes: readonly number[],
): DailyPrice[] {
  const dates: string[] = [];
  const cursor = new Date("2026-02-27T00:00:00.000Z");
  while (dates.length < closes.length) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.unshift(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return closes.map((close, index) => ({
    securityId,
    date: dates[index]!,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));
}

/** After `date`'s close and its publication delay, in either daylight-saving regime. */
export const afterClose = (date: LocalDate): Date =>
  new Date(`${date}T23:00:00.000Z`);

/** The finality policy the suites run on: weekdays, the default delay, a driven clock. */
export function fixturePolicy(clock: { now: Date }): EodFinalityPolicy {
  return new EodFinalityPolicy({
    calendar: WEEKDAY_TRADING_CALENDAR,
    now: () => clock.now,
  });
}

/**
 * The real repository, scoped to the Monitors a suite created: the database is shared with other
 * suites, and an evaluation is global by design.
 */
export function scopedRepository(
  real: MonitorEvaluationRepository,
  running: () => ReadonlySet<string>,
): MonitorEvaluationRepository {
  return {
    listActiveMonitors: async () =>
      (await real.listActiveMonitors()).filter((monitor) =>
        running().has(monitor.monitorId),
      ),
    loadSignalStates: (id) => real.loadSignalStates(id),
    loadCheckpoints: (id) => real.loadCheckpoints(id),
    loadLastRecordedSessions: (id) => real.loadLastRecordedSessions(id),
    resolveUnvisitedStates: (input) => real.resolveUnvisitedStates(input),
    pruneCheckpoints: (input) => real.pruneCheckpoints(input),
    markScanned: (monitors, now) => real.markScanned(monitors, now),
    applyMemberEvaluation: (write) => real.applyMemberEvaluation(write),
    markWatching: (ids, now) => real.markWatching(ids, now),
    // The schedule row is shared by every suite: a simulated clock never writes to it.
    recordExpectedSession: async () => {},
    loadMemberRecord: (monitorId, securityId) =>
      real.loadMemberRecord(monitorId, securityId),
    applyCoverageBackfill: (write) => real.applyCoverageBackfill(write),
    markCoverageBlocked: (input) => real.markCoverageBlocked(input),
  };
}
