import {
  MonitorEvaluableResult,
  MonitorEvaluationOutcome,
  type MonitorLevelKind,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";

/**
 * Durable Monitor state: the active Monitors a cycle evaluates, and the transition state that
 * makes trigger and condition semantics survive a restart.
 *
 * `ai/architecture/monitor-engine.md` requires ephemeral memory never to be the sole source of the
 * state a transition is decided from. Everything a cycle needs in order to tell a genuine
 * transition from a repeat is read and written here, in PostgreSQL.
 */

/** One enabled Monitor with the Strategy version and universe a cycle should evaluate. */
export type ActiveMonitor = {
  monitorId: string;
  name: string;
  actorUserId: string;
  strategyId: string;
  /** The CURRENT version. A Monitor is live, so an edited Strategy changes what it watches. */
  strategyVersionId: string;
  /** The canonical normalized definition document, still unparsed: the cycle validates it. */
  definition: unknown;
  members: readonly ActiveMonitorMember[];
};

/** One list membership, with the buy eligibility the canonical list model attaches to it. */
export type ActiveMonitorMember = {
  securityId: string;
  symbol: string;
  buyWindowMode: "FULL" | "CUSTOM";
  buyWindows: readonly { startDate: LocalDate; endDate: LocalDate | null }[];
};

/** The durable state of one `(monitor, security, level)`. */
export type PersistedSignalState = {
  id: string;
  stateVersion: number;
  /** Canonical fingerprint of the Signal this state belongs to. */
  signalFingerprint: string;
  lastEvaluableResult: "MATCHED" | "NOT_MATCHED";
  /** The most recent outcome, including `NOT_EVALUABLE`. */
  lastOutcome: MonitorEvaluationOutcome;
  activeSignalId: string | null;
  /** Observation date the most recent Trigger Signal was emitted on. */
  lastTriggerSignalDate: LocalDate | null;
};

/** One current observation: the trading session it belongs to and the price it carried. */
export type MonitorObservation = {
  date: LocalDate;
  price: number;
};

type SignalTransitionBase = {
  monitorId: string;
  securityId: string;
  levelId: string;
  levelKind: MonitorLevelKind;
  /** Recorded on an emitted Signal as the version it was decided under. */
  strategyVersionId: string;
  /** The level's own logic fingerprint: what decides whether the latched state still applies. */
  signalFingerprint: string;
  hasTrigger: boolean;
  now: Date;
  /** The state this transition was decided against, or null when there was none. */
  previous: PersistedSignalState | null;
};

/**
 * What one evaluation decided, and everything persisting the transition needs.
 *
 * The observation is optional only for `NOT_EVALUABLE`, and the split is the point: a decided
 * outcome is decided *from* an observation, so "matched, but we do not know on what" is made
 * unrepresentable rather than merely avoided. A `NOT_EVALUABLE` with no observation is the honest
 * shape of "there was nothing to evaluate" — no session, no price, and so nothing that may advance
 * a Trigger Signal's lifetime.
 */
export type SignalTransitionWrite = SignalTransitionBase &
  (
    | { outcome: "MATCHED" | "NOT_MATCHED"; observation: MonitorObservation }
    | { outcome: "NOT_EVALUABLE"; observation: MonitorObservation | null }
  );

export type SignalTransitionResult = {
  /** False when a concurrent cycle moved this state first; nothing was written. */
  applied: boolean;
  /** True when the evaluation repeated the recorded one and no write was needed. */
  unchanged?: boolean;
  emittedSignalId: string | null;
  resolvedSignalIds: readonly string[];
};

export interface MonitorRepository {
  listActiveMonitors(): Promise<ActiveMonitor[]>;
  loadSignalStates(
    monitorId: string,
  ): Promise<Map<string, PersistedSignalState>>;
  applyTransition(write: SignalTransitionWrite): Promise<SignalTransitionResult>;
  /**
   * Ends any Signal still active on a state the cycle no longer evaluates.
   *
   * A security removed from the Stock List, or a level removed from the Strategy, stops being
   * visited — and without this its Signal would stay active forever, because only an evaluation
   * ever resolves one.
   *
   * The visited set is named as the Monitor's **current** securities and levels rather than as a
   * list of row ids, because the cycle evaluates exactly their cross product: a state is unvisited
   * precisely when its security is no longer a member or its level is no longer in the definition.
   * Naming row ids instead would miss the states the same cycle just created, which have no id to
   * report until after they exist.
   */
  resolveUnvisitedSignals(input: {
    monitorId: string;
    securityIds: readonly string[];
    levelIds: readonly string[];
    now: Date;
  }): Promise<number>;
  markScanned(monitorIds: readonly string[], now: Date): Promise<void>;
}

/** The key a `(securityId, levelId)` pair is looked up by inside one Monitor's state map. */
export function signalStateKey(securityId: string, levelId: string): string {
  return `${securityId} ${levelId}`;
}

const NOTHING_WRITTEN: SignalTransitionResult = {
  applied: true,
  emittedSignalId: null,
  resolvedSignalIds: [],
};

export class PrismaMonitorRepository implements MonitorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every enabled Monitor, with its current Strategy definition and resolved universe.
   *
   * One query for the whole cycle, not one per Monitor per symbol. The universe is read through
   * `StockList` to `StockListItem` to `Security`, which is the canonical membership path — a
   * Monitor never stores a free-text symbol (`AGENTS.md` invariant 2).
   *
   * A Monitor whose Strategy somehow has no version is skipped rather than failing the cycle:
   * there is nothing to evaluate, and one malformed Monitor must not stop every other one.
   */
  async listActiveMonitors(): Promise<ActiveMonitor[]> {
    const rows = await this.prisma.monitor.findMany({
      where: { enabled: true },
      include: {
        strategy: {
          include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
        },
        stockList: {
          include: {
            items: {
              include: {
                // Only the symbol, and only so a log line can name the security. Catalog identity
                // travels as `securityId`; the ticker is never a durable identity here.
                security: { select: { symbol: true } },
                buyWindows: true,
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    const monitors: ActiveMonitor[] = [];
    for (const row of rows) {
      const version = row.strategy.versions[0];
      if (!version) {
        continue;
      }
      monitors.push({
        monitorId: row.id,
        name: row.name,
        actorUserId: row.userId,
        strategyId: row.strategyId,
        strategyVersionId: version.id,
        definition: version.definition,
        members: row.stockList.items.map((item) => ({
          securityId: item.securityId,
          symbol: item.security.symbol,
          buyWindowMode: item.buyWindowMode,
          buyWindows: item.buyWindows
            .map((window) => ({
              startDate: toLocalDate(window.startDate),
              endDate: window.endDate ? toLocalDate(window.endDate) : null,
            }))
            .sort((left, right) =>
              left.startDate.localeCompare(right.startDate),
            ),
        })),
      });
    }
    return monitors;
  }

  async loadSignalStates(
    monitorId: string,
  ): Promise<Map<string, PersistedSignalState>> {
    const rows = await this.prisma.monitorSignalState.findMany({
      where: { monitorId },
      select: {
        id: true,
        securityId: true,
        levelId: true,
        stateVersion: true,
        signalFingerprint: true,
        lastEvaluableResult: true,
        lastOutcome: true,
        activeSignalId: true,
        lastTriggerSignalDate: true,
      },
    });
    return new Map(
      rows.map((row) => [
        signalStateKey(row.securityId, row.levelId),
        {
          id: row.id,
          stateVersion: row.stateVersion,
          signalFingerprint: row.signalFingerprint,
          lastEvaluableResult: row.lastEvaluableResult,
          lastOutcome: row.lastOutcome,
          activeSignalId: row.activeSignalId,
          lastTriggerSignalDate: row.lastTriggerSignalDate
            ? toLocalDate(row.lastTriggerSignalDate)
            : null,
        },
      ]),
    );
  }

  /**
   * Ends Signals on states this cycle did not visit, in one statement per Monitor.
   *
   * Only a Monitor that was actually evaluated is reconciled — a disabled Monitor is not visited at
   * all, and its matches must stay exactly as they were so re-enabling resumes rather than restarts.
   */
  async resolveUnvisitedSignals(input: {
    monitorId: string;
    securityIds: readonly string[];
    levelIds: readonly string[];
    now: Date;
  }): Promise<number> {
    // An empty security or level list means the cross product the cycle walks is empty, so every
    // state is unvisited and the whole Monitor is swept. It is spelled out rather than left to
    // `notIn: []`, whose meaning is not worth depending on.
    const visitsNothing =
      input.securityIds.length === 0 || input.levelIds.length === 0;
    const orphaned = await this.prisma.monitorSignalState.findMany({
      where: {
        monitorId: input.monitorId,
        activeSignalId: { not: null },
        ...(visitsNothing
          ? {}
          : {
              OR: [
                { securityId: { notIn: [...input.securityIds] } },
                { levelId: { notIn: [...input.levelIds] } },
              ],
            }),
      },
      select: { id: true, activeSignalId: true },
    });
    if (orphaned.length === 0) {
      return 0;
    }

    const signalIds = orphaned
      .map((row) => row.activeSignalId)
      .filter((id): id is string => id !== null);
    await this.prisma.$transaction(async (tx) => {
      await tx.monitorSignalState.updateMany({
        where: { id: { in: orphaned.map((row) => row.id) } },
        data: {
          activeSignalId: null,
          lastEvaluableResult: MonitorEvaluableResult.NOT_MATCHED,
          // `lastOutcome` moves with the latch. The no-op fast path in `applyTransition` compares
          // outcomes while the emit decision reads the latch, so leaving the two disagreeing would
          // wedge the row: a security removed while matching and later re-added would repeat its
          // recorded outcome forever, skip the write every cycle, and never emit again.
          lastOutcome: MonitorEvaluationOutcome.NOT_MATCHED,
          // The fire date goes with the Signal it belongs to; a stale one would suppress a genuine
          // crossing on the day a member is removed and re-added.
          lastTriggerSignalDate: null,
          stateVersion: { increment: 1 },
        },
      });
      await resolveSignals(tx, signalIds, input.now);
    });
    return signalIds.length;
  }

  /**
   * Applies one evaluation to durable state, emitting or resolving a Signal only on a real edge.
   *
   * Three rules, all of them product decisions rather than implementation convenience:
   *
   * 1. **Only the edge emits.** A Signal is created on `NOT_MATCHED -> MATCHED` and nowhere else,
   *    so a Condition that stays true across scans keeps one Signal instead of a new one per cycle,
   *    and a Trigger that fired is not re-emitted while the value stays on the same side.
   * 2. **`NOT_EVALUABLE` never moves the latch.** It updates the observability columns only.
   *    Collapsing it into `NOT_MATCHED` would resolve a live match every time the provider
   *    hiccuped and re-emit it on recovery — a fabricated Signal, which the architecture forbids.
   * 3. **State latched under different logic does not decide a transition.** The comparison is the
   *    level's own canonical fingerprint, not the Strategy version: editing one condition appends a
   *    new version, and keying on that would reset every other level too and re-emit a Signal on
   *    each of them for a match that never stopped. A level whose logic really did change has its
   *    state reset and any Signal still active under the old logic resolved.
   *
   * Everything happens in one transaction guarded on the `stateVersion` the caller read. Two
   * processes whose leases briefly overlap therefore cannot both emit a Signal for one transition:
   * the second `updateMany` matches no row, the transaction rolls back the Signal it had created,
   * and the caller is told the transition was not applied.
   */
  async applyTransition(
    write: SignalTransitionWrite,
  ): Promise<SignalTransitionResult> {
    const previous = write.previous;
    const stale =
      previous !== null &&
      previous.signalFingerprint !== write.signalFingerprint;
    /** The latch that decides the edge. A stale row does not describe the current Signal. */
    const latch = stale ? null : previous;
    /** A Signal still active under a definition that no longer exists; always closed. */
    const carriedSignalId = stale ? previous.activeSignalId : null;

    // The overwhelmingly common case is an evaluation that repeats the recorded one: a condition
    // that is still true, or still false, or still not decidable. There is no edge to emit and
    // nothing to latch, and the only columns that would move are the observability timestamps —
    // which `Monitor.lastScanAt` already carries for the cycle as a whole. Returning here is what
    // keeps a cycle from opening one interactive transaction per monitor per security per level
    // when nothing has happened.
    //
    // Repeating the outcome is not on its own enough, because an event's Signal is scoped to the
    // session it fired in: a Trigger level carrying a Signal from an earlier observation date has
    // that Signal to close even though its outcome has not moved. Once it is closed the column is
    // cleared too, so this settles rather than firing on every subsequent cycle.
    const eventSessionToClose =
      write.hasTrigger &&
      previous?.activeSignalId != null &&
      closesEventSession(
        previous.lastTriggerSignalDate,
        write.observation?.date ?? null,
      );
    if (
      previous &&
      !stale &&
      previous.lastOutcome === write.outcome &&
      !eventSessionToClose
    ) {
      return {
        applied: true,
        unchanged: true,
        emittedSignalId: null,
        resolvedSignalIds: [],
      };
    }

    const isEvent = write.hasTrigger;
    /** Whether an event has already fired for the session being observed. */
    const firedThisObservation =
      write.observation !== null &&
      latch?.lastTriggerSignalDate === write.observation.date;
    /**
     * An event's Signal belongs to the session it fired in, and is closed once a **later** session
     * is observed — including one whose predicates this cycle cannot decide. Tying it to today's
     * outcome instead would leave a fired crossing open indefinitely through an outage.
     *
     * A cycle with no observation observes no session and so closes nothing: a weekend or a
     * provider outage is not a later session, and treating the wall clock as one would end a Friday
     * crossing that nothing has superseded. A market *holiday* is not distinguishable without a
     * trading calendar, which V1 does not have — an accepted limitation recorded in
     * `ai/product/monitors.md`, not a rule enforced here.
     */
    const supersededEventSignalId =
      isEvent &&
      closesEventSession(
        latch?.lastTriggerSignalDate ?? null,
        write.observation?.date ?? null,
      )
        ? (latch?.activeSignalId ?? null)
        : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (write.outcome === "NOT_EVALUABLE") {
          if (!previous) {
            // Never evaluated and still not decidable. There is no latch to preserve and nothing a
            // later evaluation could not derive, so this deliberately writes no row at all.
            return NOTHING_WRITTEN;
          }
          if (!stale) {
            // The latch is deliberately untouched — a cycle that could not decide must not end or
            // begin a match. An event's Signal from an *earlier* session is still closed here, and
            // its fire date cleared with it, so a later crossing on this session is not mistaken
            // for one that already fired.
            const result = this.guard(
              await tx.monitorSignalState.updateMany({
                where: { id: previous.id, stateVersion: previous.stateVersion },
                data: {
                  lastOutcome: write.outcome,
                  lastOutcomeAt: write.now,
                  stateVersion: { increment: 1 },
                  ...(supersededEventSignalId
                    ? { activeSignalId: null, lastTriggerSignalDate: null }
                    : {}),
                },
              }),
              {
                applied: true,
                emittedSignalId: null,
                resolvedSignalIds: supersededEventSignalId
                  ? [supersededEventSignalId]
                  : [],
              },
            );
            await resolveSignals(tx, result.resolvedSignalIds, write.now);
            return result;
          }
          // The definition changed and this cycle could not decide the new one. The row is deleted
          // rather than rewritten: its latch belongs to a definition that no longer exists, and
          // there is no evaluation to record in its place. Stamping `lastEvaluable*` here would
          // date a decision that was never made. Absence is the honest "unknown", and the next
          // decidable evaluation creates the row fresh.
          const deleted = await tx.monitorSignalState.deleteMany({
            where: { id: previous.id, stateVersion: previous.stateVersion },
          });
          this.guard(deleted, null);
          await resolveSignals(
            tx,
            carriedSignalId ? [carriedSignalId] : [],
            write.now,
          );
          return {
            applied: true,
            emittedSignalId: null,
            resolvedSignalIds: carriedSignalId ? [carriedSignalId] : [],
          };
        }

        // The union guarantees a decided outcome carries its observation.
        const observation = write.observation as MonitorObservation;
        const matched = write.outcome === "MATCHED";
        const wasMatched = latch?.lastEvaluableResult === "MATCHED";
        // An unknown previous state counts as not matched. That is what makes the first evaluation
        // after a restart emit a Signal for a genuinely matching Condition, while leaving a Trigger
        // alone: a Trigger that did not cross today evaluates FALSE whatever the Monitor
        // remembered, because its `t - 1` comes from persisted price history, not from memory.
        // A Trigger is an event on a date; a Condition is a state. `ai/architecture/monitor-engine.md`
        // scopes its `false -> true -> true -> false` table to condition-only signals and gives a
        // Trigger one rule only: emit once per observation date for the canonical crossing.
        //
        // The per-date rule is therefore the *only* thing gating an event. Reusing the condition's
        // `!wasMatched` edge here would be wrong twice over: `NOT_EVALUABLE` never moves the latch,
        // so a day the provider was down would leave it MATCHED and swallow the next day's genuine
        // crossing; and a crossing is already an edge by construction — its `t - 1` half comes from
        // the previous closed day — so it needs no second edge test.
        const emits =
          matched && (isEvent ? !firedThisObservation : !wasMatched);

        const supersededSignalId = isEvent
          ? supersededEventSignalId
          : !matched && wasMatched
            ? (latch?.activeSignalId ?? null)
            : null;

        const resolvedSignalIds = [
          ...(carriedSignalId ? [carriedSignalId] : []),
          ...(supersededSignalId ? [supersededSignalId] : []),
        ];

        let emittedSignalId: string | null = null;
        if (emits) {
          const signal = await tx.monitorSignal.create({
            data: {
              monitorId: write.monitorId,
              securityId: write.securityId,
              levelId: write.levelId,
              levelKind: write.levelKind,
              strategyVersionId: write.strategyVersionId,
              hasTrigger: write.hasTrigger,
              observationDate: toDate(observation.date),
              observationPrice: observation.price,
              detectedAt: write.now,
            },
            select: { id: true },
          });
          emittedSignalId = signal.id;
        }

        const data = {
          signalFingerprint: write.signalFingerprint,
          levelKind: write.levelKind,
          lastEvaluableResult: matched
            ? MonitorEvaluableResult.MATCHED
            : MonitorEvaluableResult.NOT_MATCHED,
          lastEvaluableDate: toDate(observation.date),
          lastEvaluableAt: write.now,
          lastOutcome: write.outcome,
          lastOutcomeAt: write.now,
          // A newly emitted Signal becomes the active one. Otherwise: an event keeps the Signal it
          // fired this session and drops one from an earlier session; a condition keeps its Signal
          // while it stays matched and drops it when it does not.
          // Cleared only when the Signal it points at is actually resolved. An event observed on an
          // *earlier* session keeps its pointer: clearing it there would orphan a live Signal that
          // nothing closed.
          activeSignalId: emits
            ? emittedSignalId
            : isEvent
              ? supersededEventSignalId
                ? null
                : undefined
              : matched
                ? undefined
                : null,
          // Set when this session fires; cleared whenever the recorded fire date no longer describes
          // the session being observed, so a stale date can never suppress a later crossing.
          lastTriggerSignalDate:
            emits && isEvent
              ? toDate(observation.date)
              : isEvent && !supersededEventSignalId && !stale
                ? undefined
                : null,
        };

        if (previous) {
          this.guard(
            await tx.monitorSignalState.updateMany({
              where: { id: previous.id, stateVersion: previous.stateVersion },
              data: { ...data, stateVersion: { increment: 1 } },
            }),
            NOTHING_WRITTEN,
          );
        } else {
          await tx.monitorSignalState.create({
            data: {
              monitorId: write.monitorId,
              securityId: write.securityId,
              levelId: write.levelId,
              ...data,
              activeSignalId: emittedSignalId,
            },
          });
        }

        await resolveSignals(tx, resolvedSignalIds, write.now);
        return { applied: true, emittedSignalId, resolvedSignalIds };
      });
    } catch (error) {
      if (
        error instanceof MonitorTransitionConflictError ||
        isBenignWriteRace(error)
      ) {
        // A concurrent cycle won this state, or the Monitor was deleted underneath it. The
        // transaction rolled back, so nothing this call created survives. Reporting it keeps one
        // contended or deleted state from failing a whole Monitor.
        return { applied: false, emittedSignalId: null, resolvedSignalIds: [] };
      }
      throw error;
    }
  }

  /**
   * Records that these Monitors were evaluated in this cycle.
   *
   * Raw SQL because `Monitor.updatedAt` is `@updatedAt`: the query builder bumps it on every write,
   * and a scan is not a user edit. Through the builder every enabled Monitor would read "updated
   * just now", the collection's newest-changed-first ordering would collapse to a tie broken by id,
   * and disabled Monitors would sink to the bottom purely because they are not being scanned.
   * `lastScanAt` is the column that carries this, and it is the only one that moves.
   */
  async markScanned(monitorIds: readonly string[], now: Date): Promise<void> {
    if (monitorIds.length === 0) {
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE "Monitor"
      SET "lastScanAt" = ${now}
      WHERE "id" = ANY(${[...monitorIds]}::text[])
    `;
  }

  /** Turns a lost optimistic guard into a rollback, so a created Signal never outlives it. */
  private guard<T>(updated: { count: number }, result: T): T {
    if (updated.count !== 1) {
      throw new MonitorTransitionConflictError();
    }
    return result;
  }
}

/**
 * Whether the session being observed ends an event Signal that fired in `firedSession`.
 *
 * **Later, not merely different.** A quote may legitimately name an *earlier* session than the one
 * already recorded — a thinly traded symbol whose provider timestamp is the previous session's last
 * trade is inside the staleness window and dates the observation to that session. Comparing with
 * inequality would close the Signal on that older reading and let the next cycle re-emit the same
 * crossing as a second Signal, which is exactly what the once-per-session rule exists to prevent.
 *
 * No observation means no session was observed, so nothing closes. An active Signal with no fired
 * session is an inconsistent row — the two always move together — and the next real observation
 * cleans it up rather than leaving it open forever.
 */
function closesEventSession(
  firedSession: LocalDate | null,
  observedSession: LocalDate | null,
): boolean {
  if (observedSession === null) {
    return false;
  }
  return firedSession === null || observedSession > firedSession;
}

/** Closes Signals, guarded on still being unresolved so a redelivery cannot move a resolution. */
async function resolveSignals(
  tx: Prisma.TransactionClient,
  signalIds: readonly string[],
  now: Date,
): Promise<void> {
  if (signalIds.length === 0) {
    return;
  }
  await tx.monitorSignal.updateMany({
    where: { id: { in: [...signalIds] }, resolvedAt: null },
    data: { resolvedAt: now },
  });
}

/** Raised inside the transaction so a lost optimistic guard rolls the created Signal back with it. */
class MonitorTransitionConflictError extends Error {
  constructor() {
    super("Monitor signal state changed concurrently");
    this.name = "MonitorTransitionConflictError";
  }
}

/**
 * Whether a write failed because the world moved, not because anything is wrong.
 *
 * - `P2002` — a concurrent cycle created the state row this one was about to create.
 * - `P2003` — the Monitor or Security was deleted between reading it and writing the transition.
 * - `P2025` — the row this write depended on no longer exists, for the same reason.
 *
 * Matched by Prisma's stable error codes, never by message text. Everything else is a real failure
 * and keeps its original semantics.
 */
const BENIGN_WRITE_RACE_CODES = new Set(["P2002", "P2003", "P2025"]);

function isBenignWriteRace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    BENIGN_WRITE_RACE_CODES.has((error as { code: string }).code)
  );
}

/** A `YYYY-MM-DD` product date as the UTC midnight PostgreSQL stores in a `date` column. */
function toDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A PostgreSQL `date` back as the canonical product string, without a timezone shift. */
function toLocalDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}
