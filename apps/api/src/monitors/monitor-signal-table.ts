import type {
  MonitorSignalPageResponse,
  MonitorSignalRowResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
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

/** A Signal table cursor this API did not issue. */
export class InvalidSignalCursorError extends Error {
  constructor() {
    super("Invalid signal table cursor");
    this.name = "InvalidSignalCursorError";
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

/**
 * The Monitor's one Signal table (`docs/decisions/monitor-eod-v2.md` §6): active occurrences first,
 * most recent activation first, then resolved ones, most recent resolution first — every occurrence
 * its own row, never collapsed by stock or level. Waiting setups are listed only when asked for.
 *
 * Each row explains itself from the decision that put it there — the activation for an active row,
 * the ending for a resolved one — under the Strategy version recorded with it. Offset-paged across
 * the two groups; pages are bounded by `limit`.
 */
export async function readSignalTable(
  prisma: PrismaService,
  logger: StructuredLogger,
  monitor: { id: string; strategyId: string },
  query: SignalTableQuery,
): Promise<MonitorSignalPageResponse> {
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  if (
    query.cursor &&
    (decoded === null ||
      typeof decoded.o !== "number" ||
      !Number.isInteger(decoded.o) ||
      decoded.o < 0)
  ) {
    throw new InvalidSignalCursorError();
  }
  const offset = (decoded?.o as number | undefined) ?? 0;
  const levelFilter = query.levelKind ? { levelKind: query.levelKind } : {};
  const onUnreadable = (versionId: string, err: unknown) =>
    logger.error({
      event: "monitor.signals.version-unreadable",
      monitorId: monitor.id,
      strategyVersionId: versionId,
      err,
    });

  if (query.state === "PENDING_TRIGGER") {
    return readPendingSetups(prisma, monitor, query, offset, onUnreadable);
  }

  const wantActive = query.state !== "RESOLVED";
  const wantResolved = query.state !== "ACTIVE";
  const activeCount = wantActive
    ? await prisma.monitorSignal.count({
        where: { monitorId: monitor.id, resolvedAt: null, ...levelFilter },
      })
    : 0;
  const include = { security: { select: SECURITY_SELECT } } as const;
  const active =
    wantActive && offset < activeCount
      ? await prisma.monitorSignal.findMany({
          where: { monitorId: monitor.id, resolvedAt: null, ...levelFilter },
          orderBy: [
            { observationDate: "desc" },
            { detectedAt: "desc" },
            { id: "desc" },
          ],
          skip: offset,
          take: query.limit + 1,
          include,
        })
      : [];
  const remaining = query.limit + 1 - active.length;
  let resolved: typeof active = [];
  if (wantResolved && remaining > 0) {
    const levelKind = query.levelKind ?? null;
    // Resolution order is the session it ended on; an administrative ending observed no session,
    // so it is placed by the New York day it was recorded.
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "MonitorSignal"
      WHERE "monitorId" = ${monitor.id} AND "resolvedAt" IS NOT NULL
        AND (${levelKind}::text IS NULL OR "levelKind"::text = ${levelKind}::text)
      ORDER BY COALESCE("resolvedObservationDate", ("resolvedAt" AT TIME ZONE 'America/New_York')::date) DESC,
        "resolvedAt" DESC, "id" DESC
      LIMIT ${remaining} OFFSET ${Math.max(0, offset - activeCount)}
    `;
    const rows = await prisma.monitorSignal.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      include,
    });
    const position = new Map(ids.map((row, index) => [row.id, index]));
    resolved = rows.sort(
      (left, right) => position.get(left.id)! - position.get(right.id)!,
    );
  }
  const combined = [...active, ...resolved];
  const page = combined.slice(0, query.limit);

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
  const versionOf = (row: (typeof page)[number]) =>
    deciding.get(row.id)?.strategyVersionId ?? row.strategyVersionId;
  const levelsByVersion = await loadStoredLevels(
    prisma,
    page.map(versionOf),
    onUnreadable,
  );
  const scopeNames = await scopeNamesFor(prisma, signalsOf(levelsByVersion));

  const rows: MonitorSignalRowResponse[] = page.map((row) => {
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
  return {
    rows,
    ...(combined.length > query.limit
      ? { nextCursor: encodeCursor({ o: offset + query.limit }) }
      : {}),
  };
}

/** Waiting setups: current `PENDING_TRIGGER` states, most recent first. */
async function readPendingSetups(
  prisma: PrismaService,
  monitor: { id: string; strategyId: string },
  query: SignalTableQuery,
  offset: number,
  onUnreadable: (versionId: string, err: unknown) => void,
): Promise<MonitorSignalPageResponse> {
  const states = await prisma.monitorSignalState.findMany({
    where: {
      monitorId: monitor.id,
      lifecycleState: "PENDING_TRIGGER",
      ...(query.levelKind ? { levelKind: query.levelKind } : {}),
    },
    orderBy: [
      { lifecycleSinceDate: { sort: "desc", nulls: "last" } },
      { lifecycleSince: "desc" },
      { id: "desc" },
    ],
    skip: offset,
    take: query.limit + 1,
    select: {
      id: true,
      securityId: true,
      levelId: true,
      levelKind: true,
      lifecycleSince: true,
      lifecycleSinceDate: true,
      lifecycleSincePrice: true,
      security: { select: SECURITY_SELECT },
    },
  });
  const page = states.slice(0, query.limit);
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
  const versionOf = (state: (typeof page)[number]) =>
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
  const rows: MonitorSignalRowResponse[] = page.map((state) => {
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
  return {
    rows,
    ...(states.length > query.limit
      ? { nextCursor: encodeCursor({ o: offset + query.limit }) }
      : {}),
  };
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
