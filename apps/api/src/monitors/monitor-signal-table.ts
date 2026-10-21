import type {
  MonitorSignalPageResponse,
  MonitorSignalRowResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import type { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import type { PrismaService } from "../database/prisma.service";
import type { SignalTableQuery } from "./monitor-requests";
import {
  decodeCursor,
  encodeCursor,
  loadStoredLevels,
  parseTransitionEvidence,
  scopeNamesFor,
  whyOf,
  type StoredLevel,
} from "./signal-why";

/** A Signal table cursor this API did not issue, or one issued for other filters. */
export class InvalidSignalCursorError extends Error {
  constructor() {
    super("Invalid signal table cursor");
    this.name = "InvalidSignalCursorError";
  }
}

/**
 * The Signal table changed after the cursor's first page was read — a session was evaluated, a
 * Monitor rebound. Continuing would mix two states of the table, so the reader starts over.
 */
export class SignalTableChangedError extends Error {
  constructor() {
    super("The Signal table changed since this page was read");
    this.name = "SignalTableChangedError";
  }
}

const SECURITY_SELECT = {
  id: true,
  symbol: true,
  name: true,
  exchangeCode: true,
  exchangeName: true,
  profile: { select: { logoUrl: true } },
} as const;

type SecurityRow = {
  id: string;
  symbol: string;
  name: string;
  exchangeCode: string;
  exchangeName: string | null;
  profile: { logoUrl: string | null } | null;
};

function securityOf(row: SecurityRow): StockListSecurityResponse {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    exchangeCode: row.exchangeCode,
    ...(row.exchangeName ? { exchangeName: row.exchangeName } : {}),
    ...(row.profile?.logoUrl ? { logoUrl: row.profile.logoUrl } : {}),
  };
}

const day = (value: Date): string => value.toISOString().slice(0, 10);

/** Which part of the table a cursor continues: active, resolved, or waiting setups. */
type SignalGroup = "A" | "R" | "W";

/**
 * Where a page ended, and what it was a page of.
 *
 * `a`, `b` and `i` are the last row's sort keys in its group; `f` names the filters and `c` the
 * table's change count when its first page was read, so a cursor continues only the table it began.
 */
type SignalCursor = {
  readonly g: SignalGroup;
  readonly a: string;
  readonly b: string;
  readonly i: string;
  readonly f: string;
  readonly c: string;
};

const filterKeyOf = (query: SignalTableQuery): string =>
  `${query.state ?? ""}|${query.levelKind ?? ""}`;

function parseCursor(text: string, filterKey: string): SignalCursor {
  const decoded = decodeCursor(text);
  const valid =
    decoded !== null &&
    (decoded.g === "A" || decoded.g === "R" || decoded.g === "W") &&
    typeof decoded.a === "string" &&
    typeof decoded.b === "string" &&
    typeof decoded.i === "string" &&
    typeof decoded.f === "string" &&
    typeof decoded.c === "string" &&
    /^\d+$/.test(decoded.c) &&
    (decoded.a === "" || !Number.isNaN(Date.parse(decoded.a))) &&
    !Number.isNaN(Date.parse(decoded.b));
  if (!valid || decoded.f !== filterKey) {
    throw new InvalidSignalCursorError();
  }
  return decoded as unknown as SignalCursor;
}

const include = { security: { select: SECURITY_SELECT } } as const;
type SignalRow = Prisma.MonitorSignalGetPayload<{ include: typeof include }>;

const WAITING_SELECT = {
  id: true,
  securityId: true,
  levelId: true,
  levelKind: true,
  lifecycleSince: true,
  lifecycleSinceDate: true,
  lifecycleSincePrice: true,
  security: { select: SECURITY_SELECT },
} satisfies Prisma.MonitorSignalStateSelect;
type WaitingRow = Prisma.MonitorSignalStateGetPayload<{
  select: typeof WAITING_SELECT;
}>;

/** The active group's order: newest activation first. */
const ACTIVE_ORDER = [
  { observationDate: "desc" },
  { detectedAt: "desc" },
  { id: "desc" },
] satisfies Prisma.MonitorSignalOrderByWithRelationInput[];

/** The resolved group's order: the newest resolution session first (`resolvedSession`). */
const RESOLVED_ORDER = [
  { resolvedSession: "desc" },
  { resolvedAt: "desc" },
  { id: "desc" },
] satisfies Prisma.MonitorSignalOrderByWithRelationInput[];

function afterActive(cursor: SignalCursor): Prisma.MonitorSignalWhereInput {
  const date = new Date(cursor.a);
  const at = new Date(cursor.b);
  return {
    OR: [
      { observationDate: { lt: date } },
      { observationDate: date, detectedAt: { lt: at } },
      { observationDate: date, detectedAt: at, id: { lt: cursor.i } },
    ],
  };
}

function afterResolved(cursor: SignalCursor): Prisma.MonitorSignalWhereInput {
  const session = new Date(cursor.a);
  const at = new Date(cursor.b);
  return {
    OR: [
      { resolvedSession: { lt: session } },
      { resolvedSession: session, resolvedAt: { lt: at } },
      { resolvedSession: session, resolvedAt: at, id: { lt: cursor.i } },
    ],
  };
}

/** Waiting setups sort by their session, newest first and undated last, then by time and id. */
function afterWaiting(
  cursor: SignalCursor,
): Prisma.MonitorSignalStateWhereInput {
  const at = new Date(cursor.b);
  if (cursor.a === "") {
    return {
      lifecycleSinceDate: null,
      OR: [
        { lifecycleSince: { lt: at } },
        { lifecycleSince: at, id: { lt: cursor.i } },
      ],
    };
  }
  const date = new Date(cursor.a);
  return {
    OR: [
      { lifecycleSinceDate: { lt: date } },
      { lifecycleSinceDate: null },
      { lifecycleSinceDate: date, lifecycleSince: { lt: at } },
      { lifecycleSinceDate: date, lifecycleSince: at, id: { lt: cursor.i } },
    ],
  };
}

/**
 * The Monitor's one Signal table (`docs/decisions/monitor-eod-v2.md` §6.2): active occurrences
 * first, most recent activation first, then resolved ones, most recent resolution first — every
 * occurrence its own row, never collapsed by stock or level. Waiting setups are listed only when
 * asked for.
 *
 * **Keyset-paged, one consistent table.** A page continues from its last row's sort keys, never
 * from an offset. Every read happens in one `REPEATABLE READ` transaction beside a count of the
 * Monitor's state transitions, which are append-only and written in the same transaction as every
 * change to an occurrence or a setup. The first page hands that count on in its cursor; a later
 * page whose count differs is refused (`SignalTableChangedError`) rather than mixed with the state
 * the reader saw — an evaluation between two pages would otherwise show an occurrence twice
 * (active, then resolved) or skip one. Within one count the table is identical, so every page is a
 * slice of the same table. The first page also counts each group.
 *
 * Each row explains itself from the decision that put it there — the activation for an active row,
 * the ending for a resolved one — under the Strategy version recorded with it.
 */
export async function readSignalTable(
  prisma: PrismaService,
  logger: StructuredLogger,
  monitor: { id: string; strategyId: string },
  query: SignalTableQuery,
): Promise<MonitorSignalPageResponse> {
  const filterKey = filterKeyOf(query);
  const cursor = query.cursor ? parseCursor(query.cursor, filterKey) : null;
  const levelFilter = query.levelKind ? { levelKind: query.levelKind } : {};
  const onUnreadable = (versionId: string, err: unknown) =>
    logger.error({
      event: "monitor.signals.version-unreadable",
      monitorId: monitor.id,
      strategyVersionId: versionId,
      err,
    });

  const read = await prisma.$transaction(
    async (tx) => {
      const changes = String(
        await tx.monitorStateTransition.count({
          where: { monitorId: monitor.id },
        }),
      );
      if (cursor && cursor.c !== changes) {
        throw new SignalTableChangedError();
      }
      const counts = cursor
        ? undefined
        : {
            active: await tx.monitorSignal.count({
              where: {
                monitorId: monitor.id,
                resolvedAt: null,
                ...levelFilter,
              },
            }),
            ended: await tx.monitorSignal.count({
              where: {
                monitorId: monitor.id,
                resolvedAt: { not: null },
                ...levelFilter,
              },
            }),
            waiting: await tx.monitorSignalState.count({
              where: {
                monitorId: monitor.id,
                lifecycleState: "PENDING_TRIGGER",
                ...levelFilter,
              },
            }),
          };

      if (query.state === "PENDING_TRIGGER") {
        if (cursor && cursor.g !== "W") throw new InvalidSignalCursorError();
        const waiting = await tx.monitorSignalState.findMany({
          where: {
            monitorId: monitor.id,
            lifecycleState: "PENDING_TRIGGER",
            ...levelFilter,
            ...(cursor ? afterWaiting(cursor) : {}),
          },
          orderBy: [
            { lifecycleSinceDate: { sort: "desc", nulls: "last" } },
            { lifecycleSince: "desc" },
            { id: "desc" },
          ],
          take: query.limit + 1,
          select: WAITING_SELECT,
        });
        return { kind: "waiting" as const, changes, counts, waiting };
      }

      if (cursor && cursor.g === "W") throw new InvalidSignalCursorError();
      const wantActive = query.state !== "RESOLVED";
      const wantResolved = query.state !== "ACTIVE";
      const inResolved = cursor?.g === "R";
      if (inResolved && !wantResolved) throw new InvalidSignalCursorError();
      const active =
        wantActive && !inResolved
          ? await tx.monitorSignal.findMany({
              where: {
                monitorId: monitor.id,
                resolvedAt: null,
                ...levelFilter,
                ...(cursor ? afterActive(cursor) : {}),
              },
              orderBy: ACTIVE_ORDER,
              take: query.limit + 1,
              include,
            })
          : [];
      const remaining = query.limit + 1 - active.length;
      const resolved =
        wantResolved && remaining > 0
          ? await tx.monitorSignal.findMany({
              where: {
                monitorId: monitor.id,
                resolvedAt: { not: null },
                ...levelFilter,
                ...(inResolved && cursor ? afterResolved(cursor) : {}),
              },
              orderBy: RESOLVED_ORDER,
              take: remaining,
              include,
            })
          : [];
      return {
        kind: "signals" as const,
        changes,
        counts,
        signals: [...active, ...resolved],
      };
    },
    { isolationLevel: "RepeatableRead" },
  );

  const page =
    read.kind === "waiting"
      ? await renderWaiting(
          prisma,
          monitor,
          read.waiting.slice(0, query.limit),
          onUnreadable,
        )
      : await renderSignals(
          prisma,
          read.signals.slice(0, query.limit),
          onUnreadable,
        );
  const more =
    read.kind === "waiting"
      ? read.waiting.length > query.limit
      : read.signals.length > query.limit;
  let nextCursor: string | undefined;
  if (more) {
    const base = { f: filterKey, c: read.changes };
    if (read.kind === "waiting") {
      const last = read.waiting[query.limit - 1]!;
      nextCursor = encodeCursor({
        ...base,
        g: "W",
        a: last.lifecycleSinceDate ? last.lifecycleSinceDate.toISOString() : "",
        b: last.lifecycleSince.toISOString(),
        i: last.id,
      });
    } else {
      const last = read.signals[query.limit - 1]!;
      nextCursor =
        last.resolvedAt === null
          ? encodeCursor({
              ...base,
              g: "A",
              a: last.observationDate.toISOString(),
              b: last.detectedAt.toISOString(),
              i: last.id,
            })
          : encodeCursor({
              ...base,
              g: "R",
              a: last.resolvedSession!.toISOString(),
              b: last.resolvedAt.toISOString(),
              i: last.id,
            });
    }
  }
  return {
    rows: page,
    ...(nextCursor ? { nextCursor } : {}),
    ...(read.counts ? { counts: read.counts } : {}),
  };
}

/** Active and resolved occurrences, each explained by the decision that put it in its group. */
async function renderSignals(
  prisma: PrismaService,
  page: readonly SignalRow[],
  onUnreadable: (versionId: string, err: unknown) => void,
): Promise<MonitorSignalRowResponse[]> {
  const transitions = await prisma.monitorStateTransition.findMany({
    where: { signalId: { in: page.map((row) => row.id) } },
    orderBy: { sequence: "asc" },
    select: {
      signalId: true,
      fromState: true,
      toState: true,
      strategyVersionId: true,
      evidence: true,
      observationDate: true,
    },
  });
  const deciding = new Map<string, (typeof transitions)[number]>();
  for (const row of page) {
    const own = transitions.filter((entry) => entry.signalId === row.id);
    const decision =
      row.resolvedAt === null
        ? own.find((entry) => entry.toState === "ACTIVE")
        : [...own].reverse().find((entry) => entry.fromState === "ACTIVE");
    if (decision) {
      deciding.set(row.id, decision);
    }
  }
  const versionOf = (row: SignalRow) =>
    deciding.get(row.id)?.strategyVersionId ?? row.strategyVersionId;
  const levelsByVersion = await loadStoredLevels(
    prisma,
    page.map(versionOf),
    onUnreadable,
  );
  const scopeNames = await scopeNamesFor(prisma, signalsOf(levelsByVersion));

  return page.map((row) => {
    const level = levelsByVersion.get(versionOf(row))?.get(row.levelId);
    const decision = deciding.get(row.id);
    const isResolved = row.resolvedAt !== null;
    const sessionDate = isResolved
      ? day(row.resolvedObservationDate ?? row.resolvedAt!)
      : day(row.observationDate);
    return {
      id: row.id,
      state: isResolved ? "RESOLVED" : "ACTIVE",
      security: securityOf(row.security),
      levelKind: row.levelKind,
      levelId: row.levelId,
      ...levelPosition(level),
      kind: row.hasTrigger ? "TRIGGER" : "CONDITION",
      sessionDate,
      activatedOn: day(row.observationDate),
      activationPrice: Number(row.observationPrice),
      observationBasis: row.observationBasis,
      ...(row.resolvedObservationDate
        ? { resolvedOn: day(row.resolvedObservationDate) }
        : {}),
      ...(row.resolutionReason
        ? { resolutionReason: row.resolutionReason }
        : {}),
      fromHistory: row.reconstructed,
      ...(level
        ? {
            why: whyOf(
              level,
              parseTransitionEvidence(decision?.evidence),
              scopeNames,
              decision?.observationDate
                ? day(decision.observationDate)
                : undefined,
            ),
          }
        : {}),
    };
  });
}

/** Waiting setups: current `PENDING_TRIGGER` states, explained by the setup that began each. */
async function renderWaiting(
  prisma: PrismaService,
  monitor: { id: string; strategyId: string },
  page: readonly WaitingRow[],
  onUnreadable: (versionId: string, err: unknown) => void,
): Promise<MonitorSignalRowResponse[]> {
  const setups =
    page.length === 0
      ? []
      : await prisma.monitorStateTransition.findMany({
          where: {
            monitorId: monitor.id,
            toState: "PENDING_TRIGGER",
            OR: page.map((state) => ({
              securityId: state.securityId,
              levelId: state.levelId,
            })),
          },
          orderBy: { sequence: "desc" },
          select: {
            securityId: true,
            levelId: true,
            strategyVersionId: true,
            evidence: true,
            observationDate: true,
            origin: true,
          },
        });
  const latestSetup = new Map<string, (typeof setups)[number]>();
  for (const setup of setups) {
    const key = `${setup.securityId} ${setup.levelId}`;
    if (!latestSetup.has(key)) {
      latestSetup.set(key, setup);
    }
  }
  // A waiting setup is current state under the current logic; the current version describes it
  // when its setup transition predates recorded versions.
  const current = await prisma.strategyVersion.findFirst({
    where: { strategyId: monitor.strategyId },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
  });
  const versionOf = (state: WaitingRow) =>
    latestSetup.get(`${state.securityId} ${state.levelId}`)
      ?.strategyVersionId ??
    current?.id ??
    null;
  const levelsByVersion = await loadStoredLevels(
    prisma,
    page.flatMap((state) => {
      const version = versionOf(state);
      return version ? [version] : [];
    }),
    onUnreadable,
  );
  const scopeNames = await scopeNamesFor(prisma, signalsOf(levelsByVersion));
  return page.map((state) => {
    const version = versionOf(state);
    const level = version
      ? levelsByVersion.get(version)?.get(state.levelId)
      : undefined;
    const setup = latestSetup.get(`${state.securityId} ${state.levelId}`);
    const since = state.lifecycleSinceDate ?? state.lifecycleSince;
    return {
      id: state.id,
      state: "PENDING_TRIGGER",
      security: securityOf(state.security),
      levelKind: state.levelKind,
      levelId: state.levelId,
      ...levelPosition(level),
      kind: "TRIGGER",
      sessionDate: day(since),
      activatedOn: day(since),
      ...(state.lifecycleSincePrice === null
        ? {}
        : { activationPrice: Number(state.lifecycleSincePrice) }),
      // The setup began on a session the Monitor was not watching: history established it.
      fromHistory: setup?.origin === "HISTORY",
      ...(level
        ? {
            why: whyOf(
              level,
              parseTransitionEvidence(setup?.evidence),
              scopeNames,
              setup?.observationDate ? day(setup.observationDate) : undefined,
            ),
          }
        : {}),
    };
  });
}

function levelPosition(
  level: StoredLevel | undefined,
): Pick<MonitorSignalRowResponse, "levelIndex" | "levelPercentage"> {
  return {
    ...(level?.index === undefined ? {} : { levelIndex: level.index }),
    ...(level?.percentage === undefined
      ? {}
      : { levelPercentage: level.percentage }),
  };
}

function signalsOf(
  levelsByVersion: ReadonlyMap<string, ReadonlyMap<string, StoredLevel>>,
) {
  return [...levelsByVersion.values()].flatMap((levels) =>
    [...levels.values()].flatMap((level) =>
      level.rules.map((rule) => rule.signal),
    ),
  );
}
