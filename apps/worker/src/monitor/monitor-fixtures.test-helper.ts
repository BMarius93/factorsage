import type { DailyPrice, Security, SecurityId } from "@intrinsic/domain";
import {
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
  type CurrentObservation,
  type MonitorEvaluationFrame,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import {
  createEvaluationFrame,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import type { MonitorDataLoader } from "./monitor-cycle.js";

/**
 * The market-data and calendar boundaries the Monitor suites drive.
 *
 * Two suites need them: `monitor-cycle.integration.test.ts`, which asserts what a cycle decides
 * across a wide surface, and `monitor-transitions.fixture.test.ts`, which replays named session
 * sequences against a table of expected transitions. They are here so both drive the same
 * boundaries — a second loader would be a second definition of what "the market said" means, and
 * the two suites would stop being about the same product.
 *
 * Only these two boundaries are replaced. The repository, the transitions, the optimistic guard,
 * the frames (`projectMonitorEvaluationFrame`) and the observation dating are the production ones.
 */

/**
 * A loader driven by a fixed price history and a settable current price.
 *
 * It counts what it was asked for, which is how the "several Monitors share one symbol snapshot"
 * expectation is asserted without reaching into the cycle's private state.
 */
export class FixtureLoader implements MonitorDataLoader {
  prices = new Map<SecurityId, DailyPrice[]>();
  currentPrice: number | null = null;
  currentDataError: Error | null = null;
  quotedAt: string | undefined = undefined;

  prepareCalls: string[] = [];
  frameCalls: string[] = [];
  quoteCalls = 0;
  lastRequestedOperands = new Map<SecurityId, readonly OperandKey[]>();
  lastRequestedObservations = new Map<SecurityId, number>();

  constructor(private readonly securities: Security[]) {}

  resetCounters(): void {
    this.prepareCalls = [];
    this.frameCalls = [];
    this.quoteCalls = 0;
  }

  async findSecurities(ids: readonly SecurityId[]): Promise<Security[]> {
    return this.securities.filter((security) => ids.includes(security.id));
  }

  async getCurrentObservations(
    securities: readonly Security[],
  ): Promise<Map<SecurityId, CurrentObservation>> {
    this.quoteCalls += 1;
    if (this.currentDataError) {
      throw this.currentDataError;
    }
    const observations = new Map<SecurityId, CurrentObservation>();
    if (this.currentPrice === null) {
      return observations;
    }
    for (const security of securities) {
      observations.set(security.id, {
        price: this.currentPrice,
        ...(this.quotedAt === undefined ? {} : { quotedAt: this.quotedAt }),
      });
    }
    return observations;
  }

  async prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    _asOf: string,
  ): Promise<void> {
    this.prepareCalls.push(security.id);
    this.lastRequestedObservations.set(security.id, observations);
  }

  async readMonitorEvaluationFrame(input: {
    security: Security;
    operands: readonly OperandKey[];
    observations: number;
    asOf: string;
    observation: CurrentObservation | null;
    observationDate: string;
  }): Promise<MonitorEvaluationFrame | null> {
    this.frameCalls.push(input.security.id);
    this.lastRequestedOperands.set(input.security.id, input.operands);
    const prices = this.prices.get(input.security.id) ?? [];
    // The date the cycle computed, not one the fixture picks. Substituting here would make the
    // session-dating half of production unobservable: deriving the observation date in UTC instead
    // of the exchange's own clock would not fail a single test in this file.
    return projectMonitorEvaluationFrame({
      security: input.security,
      prices,
      derived: [],
      operands: input.operands,
      observation: input.observation,
      observationDate: input.observationDate,
    });
  }

  monitorWindowObservations(operands: readonly OperandKey[]): number {
    return monitorWindowObservations(requiredDailySeries(operands));
  }

  /** When true, reconstruction sees the history with its SMA columns materialized. */
  historyFrames = false;
  historyError: Error | null = null;
  historyCalls: string[] = [];

  historyRanges: { securityId: string; from: string; to: string }[] = [];
  /** Where each security's canonical history begins; its first persisted close by default. */
  historyStart = new Map<SecurityId, string>();

  async prepareReconstructionData(
    security: Security,
    range: { from: string; to: string },
  ): Promise<void> {
    this.historyCalls.push(security.id);
    this.historyRanges.push({ securityId: security.id, ...range });
    if (this.historyError) {
      throw this.historyError;
    }
  }

  reconstructionHistoryStart(security: Security): string {
    return (
      this.historyStart.get(security.id) ??
      this.prices.get(security.id)?.[0]?.date ??
      "2000-01-03"
    );
  }

  async readReconstructionFrame(
    security: Security,
    range: { from: string; to: string },
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame> {
    const prices = this.historyFrames
      ? (this.prices.get(security.id) ?? []).filter(
          (price) => price.date <= range.to,
        )
      : [];
    // Like the canonical frame: everything earlier is warm-up context, and the period — the
    // sessions a replay may step through — begins at `range.from`.
    const firstInRange = prices.findIndex((price) => price.date >= range.from);
    const periodStartIndex = firstInRange < 0 ? prices.length : firstInRange;
    const closes = prices.map((price) => price.close);
    const columns = new Map<OperandKey, Float64Array>();
    for (const operand of operands) {
      const period = /^series:SMA_(\d+)D$/.exec(operand)?.[1];
      if (period) {
        columns.set(operand, rollingMean(closes, Number(period)));
      }
    }
    return createEvaluationFrame({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      dates: prices.map((price) => price.date),
      closes: Float64Array.from(closes),
      columns,
      periodStartIndex,
    });
  }
}

/** The canonical SMA definition, as a materialized column would hold it. */
function rollingMean(values: readonly number[], period: number): Float64Array {
  return Float64Array.from(values, (_, index) => {
    if (index + 1 < period) {
      return Number.NaN;
    }
    let sum = 0;
    for (let cursor = index + 1 - period; cursor <= index; cursor += 1) {
      sum += values[cursor]!;
    }
    return sum / period;
  });
}

/** A plausible year of full closures, so the calendar's plausibility floor is satisfied. */
export const FULL_YEAR_2026 = [
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
].map((date) => ({ date, fullClose: true }));

/**
 * A calendar the tests drive: every weekday is a session unless named as a full close.
 *
 * It counts its calls, which is how "one schedule per exchange, not per symbol" is asserted without
 * reaching into the production cache.
 */
export class FixtureCalendar implements TradingCalendar {
  fullCloses = new Set<string>();
  failure: Error | null = null;
  calls: string[] = [];

  async isTradingSession(exchangeCode: string, date: string): Promise<boolean> {
    this.calls.push(`${exchangeCode} ${date}`);
    if (this.failure) {
      throw this.failure;
    }
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day === 0 || day === 6) {
      return false;
    }
    return !this.fullCloses.has(date);
  }
}

/** Twenty-five flat weekday closes, so a 20-bar SMA is warmed up and exactly equal to `close`. */
export function flatHistory(securityId: string, close: number): DailyPrice[] {
  const prices: DailyPrice[] = [];
  const cursor = new Date("2026-01-26T00:00:00.000Z"); // a Monday
  for (let index = 0; index < 25; index += 1) {
    prices.push({
      securityId,
      date: cursor.toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    });
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  }
  return prices;
}

/**
 * Twenty-five rising weekday closes.
 *
 * The last closed day is already well above its own 20-bar average, so `previousMetric <=
 * previousValue` is false there — which is what makes "the price is on the post-cross side but did
 * not cross today" expressible. A flat history cannot express it: price equals the average exactly,
 * and `<=` holds on every bar.
 */
export function risingHistory(securityId: string): DailyPrice[] {
  return flatHistory(securityId, 0).map((price, index) => {
    const close = 100 + index * 2;
    return { ...price, open: close, high: close, low: close, close };
  });
}

/**
 * Closes on consecutive weekdays ending on Friday 2026-02-27, so every driven session is later.
 */
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
