import { randomUUID } from "node:crypto";
import {
  monitorActivityWindowStart,
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyTrigger,
} from "@intrinsic/contracts";
import { PrismaClient, SecurityType } from "@intrinsic/database";
import type {
  DailyDerivedState,
  DailyPrice,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import { createLogger } from "@intrinsic/observability";
import {
  aggregateCompletedWeeks,
  buildDailyDerivedState,
  EodFinalityPolicy,
  resolveWeekSessionEnds,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import {
  collectOperands,
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  monitorStrategyLevels,
  observeMonitorLevel,
  stepMonitorLevel,
} from "@intrinsic/strategy";
import { useTestDatabase } from "@intrinsic/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MonitorEodEvaluation } from "./monitor-evaluation.js";
import {
  EodFixtureData,
  scopedRepository,
} from "./monitor-evaluation.test-helper.js";
import { PrismaMonitorRepository } from "./monitor-repository.js";

// Before any PrismaClient in this file is constructed.
useTestDatabase();

/**
 * Differential properties of the Monitor EOD evaluation over generated histories
 * (`docs/decisions/monitor-eod-v2.md` §3, §5, §9, §10). For every seed, the same history and the same
 * Strategy are decided in several ways, and every way must record the same changes, on the same
 * sessions, as a backtest over the finished history:
 *
 * - **incremental** — one pass every evening, plus one before each session is final (which must
 *   decide nothing for it), with the derived rows materialized as of that evening;
 * - **catch-up** — a pass on the first evening and one on the last, every session in between in one
 *   chronological catch-up;
 * - **restarts** — passes on a deterministic subset of evenings;
 * - **window replay** — a new Monitor replaying its rolling 30-day window on the last evening, and
 *   one that replays mid-way and then continues from its checkpoint;
 * - **Strategy edit** — an edit mid-way: the edited level matches the new logic's backtest from the
 *   edit on, the untouched levels keep matching the old one.
 *
 * Histories carry venue holidays, sessions the security did not print (halts), regime moves that
 * make crossings, and weekly averages that cross on a week's last session. The repository and its
 * transactions are real PostgreSQL; the bars are the in-memory stand-in for stored rows.
 */

const HISTORY_FROM: LocalDate = "2025-01-06";
const HISTORY_TO: LocalDate = "2026-06-26";
const WINDOW_SESSIONS = 60;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const HOLIDAYS = new Set<LocalDate>([
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
]);

function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isSession(date: LocalDate): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6 && !HOLIDAYS.has(date);
}

const calendar: TradingCalendar = {
  isTradingSession: async (_exchange, date) => isSession(date),
};

/** A deterministic value in [0, 1): never `Math.random`. */
function noise(seed: number, index: number): number {
  const value = Math.sin(seed * 7919 + index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * One generated history: every scheduled session, a random walk with a regime shift about every
 * fifteen sessions (so averages are crossed both ways), and about one session in a hundred and
 * twenty not printed — never in the last ten, so the late-recovery horizon has passed before the
 * last evening.
 */
function generatedPrices(seed: number, securityId: string): DailyPrice[] {
  const sessions: LocalDate[] = [];
  for (let date = HISTORY_FROM; date <= HISTORY_TO; date = addDays(date, 1)) {
    if (isSession(date)) {
      sessions.push(date);
    }
  }
  const rows: DailyPrice[] = [];
  let close = 100;
  let drift = 0;
  sessions.forEach((date, index) => {
    if (index % 15 === 0) {
      drift = (noise(seed, index) - 0.5) * 0.02;
    }
    close = Math.max(
      5,
      close * (1 + drift + (noise(seed + 101, index) - 0.5) * 0.03),
    );
    const halted =
      index < sessions.length - 10 && noise(seed + 202, index) < 1 / 120;
    if (!halted) {
      const value = Math.round(close * 100) / 100;
      rows.push({
        securityId,
        date,
        open: value,
        high: value,
        low: value,
        close: value,
        volume: 1_000_000,
      });
    }
  });
  return rows;
}

/** The derived rows the stock EOD child materializes at the EOD cutoff `asOf`. */
async function rowsAt(
  prices: readonly DailyPrice[],
  asOf: LocalDate,
): Promise<DailyDerivedState[]> {
  const stored = prices.filter((price) => price.date <= asOf);
  const sessionEnds = await resolveWeekSessionEnds({
    dates: stored.map((price) => price.date),
    isScheduledSession: async (date) => isSession(date),
  });
  return buildDailyDerivedState({
    prices: stored,
    weeklyBars: aggregateCompletedWeeks(stored, asOf, undefined, sessionEnds),
  });
}

/**
 * A resting state, written the same way on both sides. A reconstruction stores a level that came to
 * rest as `INACTIVE` rather than `RESOLVED` — no occurrence was ever recorded for it — so the first
 * change after one reads `INACTIVE->…` where a replay from the first session reads `RESOLVED->…`.
 * Both mean nothing is current; the session, the reason and the destination are what must agree.
 */
const resting = (state: string) => (state === "RESOLVED" ? "INACTIVE" : state);

const above = (
  id: string,
  seriesId: "SMA_20D" | "SMA_50D",
): StrategyCondition => ({
  id,
  metric: { kind: "PRICE" },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId },
});
const crosses = (
  id: string,
  operator: "CROSSES_ABOVE" | "CROSSES_BELOW",
  seriesId: "SMA_20D" | "EMA_20D" | "SMA_20W",
): StrategyTrigger => ({
  id,
  metric: { kind: "PRICE" },
  operator,
  value: { kind: "SERIES", seriesId },
});

/** Five levels: Conditions, Trigger, Conditions + Trigger, a weekly Trigger, a FINAL EXIT of two. */
function strategy(triggerSeries: "EMA_20D" | "SMA_20D"): StrategyDefinition {
  return normalizeStrategyDefinition({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-conditions",
        percentage: 25,
        signal: { conditions: [above("c1", "SMA_20D")] },
      },
      {
        id: "buy-trigger",
        percentage: 25,
        signal: {
          conditions: [],
          trigger: crosses("t1", "CROSSES_ABOVE", triggerSeries),
        },
      },
      {
        id: "buy-setup",
        percentage: 25,
        signal: {
          conditions: [above("c2", "SMA_50D")],
          trigger: crosses("t2", "CROSSES_ABOVE", "SMA_20D"),
        },
      },
      {
        id: "buy-weekly",
        percentage: 25,
        signal: {
          conditions: [],
          trigger: crosses("t3", "CROSSES_ABOVE", "SMA_20W"),
        },
      },
    ],
    sellLevels: [],
    finalExit: {
      id: "exit",
      rules: [
        {
          id: "exit-cross",
          signal: {
            conditions: [],
            trigger: crosses("t4", "CROSSES_BELOW", "SMA_20D"),
          },
        },
        { id: "exit-below", signal: { conditions: [above("c3", "SMA_50D")] } },
      ],
    },
  });
}

describe("one history, many ways to decide it, one record", () => {
  const prisma = new PrismaClient();
  const real = new PrismaMonitorRepository(prisma);
  const running = new Set<string>();
  const repository = scopedRepository(real, () => running);
  const logger = createLogger({ service: "worker", level: "silent" });
  const clock = { now: new Date(`${HISTORY_TO}T23:00:00.000Z`) };
  const policy = new EodFinalityPolicy({ calendar, now: () => clock.now });
  const userIds: string[] = [];
  const securityIds: string[] = [];
  /** Changes each seed's backtest recorded: the properties are only as strong as these are many. */
  const recordedPerSeed: string[][] = [];
  let cycle = 0;

  beforeEach(() => running.clear());

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    await prisma.$disconnect();
  });

  async function createSecurity(): Promise<Security> {
    const symbol = `DIF${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const row = await prisma.security.create({
      data: {
        providerSymbol: symbol,
        symbol,
        name: `${symbol} Corp`,
        exchangeCode: "NASDAQ",
        currency: "USD",
        type: SecurityType.STOCK,
        isAdr: false,
        isActivelyTrading: true,
      },
    });
    securityIds.push(row.id);
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchangeCode: row.exchangeCode,
      currency: row.currency,
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
    };
  }

  async function createMonitor(
    security: Security,
    definition: StrategyDefinition,
    options: { replay?: boolean } = {},
  ) {
    const user = await prisma.user.create({
      data: { email: `differential-${randomUUID()}@example.test`, plan: "PRO" },
    });
    userIds.push(user.id);
    const strategyRow = await prisma.strategy.create({
      data: {
        userId: user.id,
        name: `Differential ${randomUUID().slice(0, 8)}`,
        versions: {
          create: {
            versionNumber: 1,
            definition: definition as never,
            definitionHash: randomUUID(),
          },
        },
      },
    });
    const list = await prisma.stockList.create({
      data: {
        userId: user.id,
        name: `Differential ${randomUUID().slice(0, 8)}`,
        items: {
          create: [
            {
              securityId: security.id,
              createdAt: new Date(`${HISTORY_FROM}T00:00:00.000Z`),
            },
          ],
        },
      },
    });
    const monitor = await prisma.monitor.create({
      data: {
        userId: user.id,
        name: `Differential ${randomUUID().slice(0, 8)}`,
        strategyId: strategyRow.id,
        stockListId: list.id,
        enabled: true,
        windowReplay: options.replay === true,
      },
    });
    running.add(monitor.id);
    return { monitorId: monitor.id, strategyId: strategyRow.id };
  }

  /** One pass at `at`, over the bars stored by then, materialized as of that cutoff. */
  async function passAt(
    data: EodFixtureData,
    security: Security,
    all: readonly DailyPrice[],
    at: Date,
  ) {
    clock.now = at;
    const cutoff = policy.cutoffDate(at);
    const stored = all.filter((price) => price.date <= cutoff);
    data.prices.set(security.id, stored);
    data.derived.set(security.id, await rowsAt(stored, cutoff));
    return new MonitorEodEvaluation(repository, data, policy, logger, {
      securityConcurrency: 1,
      lateRecoveryMs: 4 * 24 * 60 * 60_000,
      now: () => clock.now,
    }).run((cycle += 1));
  }

  const evening = (date: LocalDate) => new Date(`${date}T23:00:00.000Z`);
  /** 18:00 UTC: 14:00 New York — the session is trading, nothing of it is final. */
  const midSession = (date: LocalDate) => new Date(`${date}T18:00:00.000Z`);

  async function changesOf(
    monitorId: string,
    from: LocalDate,
    levelId?: string,
  ) {
    const rows = await prisma.monitorStateTransition.findMany({
      where: { monitorId, ...(levelId ? { levelId } : {}) },
      orderBy: { sequence: "asc" },
    });
    return rows
      .filter(
        (row) =>
          row.observationDate !== null &&
          row.reason !== "RECONSTRUCTED" &&
          row.reason !== "LOGIC_CHANGED" &&
          row.observationDate.toISOString().slice(0, 10) > from,
      )
      .map(
        (row) =>
          `${row.levelId} ${row.observationDate!.toISOString().slice(0, 10)} ${resting(row.fromState)}->${row.toState} ${row.reason}`,
      )
      .sort();
  }

  /** The backtest's record of every level over the finished history, after `from`. */
  async function backtestChanges(
    security: Security,
    all: readonly DailyPrice[],
    definition: StrategyDefinition,
    from: LocalDate,
    levelIds?: readonly string[],
  ) {
    const data = new EodFixtureData([security]);
    data.prices.set(security.id, [...all]);
    data.derived.set(security.id, await rowsAt(all, HISTORY_TO));
    const { frame } = await data.readFinalizedEvaluationFrame(
      security,
      { from: all[0]!.date, to: HISTORY_TO },
      collectOperands(definition),
    );
    const changes: string[] = [];
    for (const level of monitorStrategyLevels(definition)) {
      if (levelIds && !levelIds.includes(level.id)) {
        continue;
      }
      let lifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE;
      for (
        let index = frame.periodStartIndex;
        index < frame.dates.length;
        index += 1
      ) {
        const date = frame.dates[index]!;
        const result = stepMonitorLevel(lifecycle, {
          date,
          eligible: true,
          rules: observeMonitorLevel(level, frame, index),
        });
        if (date > from) {
          changes.push(
            ...result.transitions.map(
              (transition) =>
                `${level.id} ${date} ${resting(transition.from)}->${transition.to} ${transition.reason}`,
            ),
          );
        }
        lifecycle = result.next;
      }
    }
    return changes.sort();
  }

  it.each(SEEDS)(
    "seed %i: incremental, catch-up, restarts and the backtest record the same changes",
    async (seed) => {
      const definition = strategy("EMA_20D");
      const template = generatedPrices(seed, "template");
      const sessions = template.map((price) => price.date);
      const start = sessions[sessions.length - 1 - WINDOW_SESSIONS]!;
      const days: LocalDate[] = [];
      for (let date = start; date <= HISTORY_TO; date = addDays(date, 1)) {
        days.push(date);
      }

      // Incremental, with a pass before every session is final.
      const incremental = await createSecurity();
      const incrementalPrices = template.map((price) => ({
        ...price,
        securityId: incremental.id,
      }));
      const incrementalData = new EodFixtureData([incremental]);
      const first = await createMonitor(incremental, definition);
      for (const date of days) {
        if (isSession(date)) {
          await passAt(
            incrementalData,
            incremental,
            incrementalPrices,
            midSession(date),
          );
          const through = (
            await prisma.monitorEvaluationCheckpoint.findUnique({
              where: {
                monitorId_securityId: {
                  monitorId: first.monitorId,
                  securityId: incremental.id,
                },
              },
            })
          )?.evaluatedThrough
            .toISOString()
            .slice(0, 10);
          expect(
            through === undefined || through < date,
            `seed ${seed}: ${through} before ${date} closed`,
          ).toBe(true);
        }
        await passAt(
          incrementalData,
          incremental,
          incrementalPrices,
          evening(date),
        );
      }

      // One chronological catch-up.
      const catchUp = await createSecurity();
      const catchUpPrices = template.map((price) => ({
        ...price,
        securityId: catchUp.id,
      }));
      const catchUpData = new EodFixtureData([catchUp]);
      const second = await createMonitor(catchUp, definition);
      await passAt(catchUpData, catchUp, catchUpPrices, evening(start));
      await passAt(catchUpData, catchUp, catchUpPrices, evening(HISTORY_TO));

      // Restarts on a deterministic subset of evenings.
      const restarts = await createSecurity();
      const restartPrices = template.map((price) => ({
        ...price,
        securityId: restarts.id,
      }));
      const restartData = new EodFixtureData([restarts]);
      const third = await createMonitor(restarts, definition);
      await passAt(restartData, restarts, restartPrices, evening(start));
      for (const [index, date] of days.entries()) {
        if (noise(seed + 303, index) < 0.25) {
          await passAt(restartData, restarts, restartPrices, evening(date));
        }
      }
      await passAt(restartData, restarts, restartPrices, evening(HISTORY_TO));

      const expected = await backtestChanges(
        incremental,
        incrementalPrices,
        definition,
        start,
      );
      recordedPerSeed.push(expected);
      const strip = (changes: string[]) => changes.join("\n");
      expect(
        strip(await changesOf(first.monitorId, start)),
        `seed ${seed} incremental`,
      ).toBe(strip(expected));
      expect(
        strip(await changesOf(second.monitorId, start)),
        `seed ${seed} catch-up`,
      ).toBe(strip(expected));
      expect(
        strip(await changesOf(third.monitorId, start)),
        `seed ${seed} restarts`,
      ).toBe(strip(expected));
    },
    240_000,
  );

  it.each(SEEDS)(
    "seed %i: a window replay records its window as the backtest does, and continues from its checkpoint",
    async (seed) => {
      const definition = strategy("EMA_20D");
      const template = generatedPrices(seed, "template");
      const sessions = template.map((price) => price.date);
      const middle = sessions[sessions.length - 31]!;

      // Replay on the last evening: the rolling 30-day window ending at it.
      const whole = await createSecurity();
      const wholePrices = template.map((price) => ({
        ...price,
        securityId: whole.id,
      }));
      const wholeData = new EodFixtureData([whole]);
      const replayed = await createMonitor(whole, definition, { replay: true });
      const summary = await passAt(
        wholeData,
        whole,
        wholePrices,
        evening(HISTORY_TO),
      );
      expect(summary.membersReplayed).toBe(1);
      const window = monitorActivityWindowStart(summary.expectedSession);
      const beforeWindow = addDays(window, -1);
      expect(
        (await changesOf(replayed.monitorId, beforeWindow)).join("\n"),
        `seed ${seed} replay`,
      ).toBe(
        (
          await backtestChanges(whole, wholePrices, definition, beforeWindow)
        ).join("\n"),
      );

      // Replay mid-way, then a checkpointed continuation evening by evening.
      const continued = await createSecurity();
      const continuedPrices = template.map((price) => ({
        ...price,
        securityId: continued.id,
      }));
      const continuedData = new EodFixtureData([continued]);
      const resumed = await createMonitor(continued, definition, {
        replay: true,
      });
      const firstPass = await passAt(
        continuedData,
        continued,
        continuedPrices,
        evening(middle),
      );
      for (
        let date = addDays(middle, 1);
        date <= HISTORY_TO;
        date = addDays(date, 1)
      ) {
        await passAt(continuedData, continued, continuedPrices, evening(date));
      }
      // The window of the pass that first evaluated it; later passes catch up from the checkpoint.
      const resumedWindow = monitorActivityWindowStart(
        firstPass.expectedSession,
      );
      const beforeResumed = addDays(resumedWindow, -1);
      expect(
        (await changesOf(resumed.monitorId, beforeResumed)).join("\n"),
        `seed ${seed} replay + continuation`,
      ).toBe(
        (
          await backtestChanges(
            continued,
            continuedPrices,
            definition,
            beforeResumed,
          )
        ).join("\n"),
      );
    },
    240_000,
  );

  it.each(SEEDS)(
    "seed %i: a Strategy edit mid-way moves only the edited level onto the new logic",
    async (seed) => {
      const before = strategy("EMA_20D");
      const after = strategy("SMA_20D");
      const template = generatedPrices(seed, "template");
      const sessions = template.map((price) => price.date);
      const start = sessions[sessions.length - 1 - WINDOW_SESSIONS]!;
      const editOn = sessions[sessions.length - 31]!;

      const security = await createSecurity();
      const prices = template.map((price) => ({
        ...price,
        securityId: security.id,
      }));
      const data = new EodFixtureData([security]);
      const { monitorId, strategyId } = await createMonitor(security, before);
      for (let date = start; date <= HISTORY_TO; date = addDays(date, 1)) {
        if (date === addDays(editOn, 1)) {
          await prisma.strategyVersion.create({
            data: {
              strategyId,
              versionNumber: 2,
              definition: after as never,
              definitionHash: randomUUID(),
            },
          });
        }
        await passAt(data, security, prices, evening(date));
      }
      const untouched = ["buy-conditions", "buy-setup", "buy-weekly", "exit"];
      expect(
        (await changesOf(monitorId, start))
          .filter((change) =>
            untouched.some((id) => change.startsWith(`${id} `)),
          )
          .join("\n"),
        `seed ${seed} untouched levels`,
      ).toBe(
        (
          await backtestChanges(security, prices, before, start, untouched)
        ).join("\n"),
      );
      // The edited level: the old logic through the edit, the new logic's record after it.
      const edited = await changesOf(monitorId, start, "buy-trigger");
      expect(
        edited.filter((change) => change.split(" ")[1]! <= editOn).join("\n"),
        `seed ${seed} edited level before the edit`,
      ).toBe(
        (
          await backtestChanges(security, prices, before, start, [
            "buy-trigger",
          ])
        )
          .filter((change) => change.split(" ")[1]! <= editOn)
          .join("\n"),
      );
      expect(
        edited.filter((change) => change.split(" ")[1]! > editOn).join("\n"),
        `seed ${seed} edited level after the edit`,
      ).toBe(
        (
          await backtestChanges(security, prices, after, editOn, [
            "buy-trigger",
          ])
        ).join("\n"),
      );
    },
    240_000,
  );

  it("exercised real changes: most seeds record several, across every kind of level", () => {
    expect(recordedPerSeed).toHaveLength(SEEDS.length);
    expect(
      recordedPerSeed.filter((changes) => changes.length > 0).length,
    ).toBeGreaterThanOrEqual(SEEDS.length - 2);
    const all = recordedPerSeed.flat();
    expect(all.length).toBeGreaterThanOrEqual(40);
    for (const level of [
      "buy-conditions",
      "buy-trigger",
      "buy-setup",
      "buy-weekly",
      "exit",
    ]) {
      expect(
        all.some((change) => change.startsWith(`${level} `)),
        level,
      ).toBe(true);
    }
  });
});
