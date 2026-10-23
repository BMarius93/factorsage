import {
  monitorActivityWindowStart,
  type MonitorSynchronizationResponse,
} from "@intrinsic/contracts";
import {
  isOngoingListMember,
  ongoingMembershipStart,
  type LocalDate,
} from "@intrinsic/domain";
import type { PrismaService } from "../database/prisma.service";
import { latestMonitorSession } from "./monitor-activity-window";

/** The Monitor facts the synchronization state is read from. */
export type SynchronizationSubject = {
  id: string;
  stockListId: string;
  configVersion: number;
  watchingSince: Date | null;
  lastScanAt: Date | null;
};

/**
 * Where each running Monitor's evaluation stands against the rolling activity window
 * (`docs/decisions/monitor-eod-v2.md` §12), from durable facts alone, in two reads for any number of
 * Monitors.
 *
 * - **Has a pass completed since it started running?** `watchingSince` is stamped by the first pass
 *   that finds the Monitor running (it is cleared while disabled, plan-blocked or globally paused)
 *   and `lastScanAt` by the end of every pass, both with that pass's own instant — so
 *   `lastScanAt >= watchingSince` says exactly that one finished since, and nothing else is read
 *   from a clock. A rebind clears `lastScanAt` and waits for one too.
 * - **Is every current member's window recorded?** A member's checkpoint under the current binding
 *   says where its recorded evaluation begins (`coverageStart`); the window is covered when that is on
 *   or before the window's first day, or its ongoing membership's later start. A member whose
 *   coverage begins later is still being completed — the worker decides its missing sessions
 *   (§12.2) — unless that back-fill found them irreconcilable with what is recorded
 *   (`coverageBlockedFrom`): that member's history genuinely starts later. A member with no
 *   checkpoint after a completed pass has no market data to be evaluated on yet.
 *
 * So `SYNCHRONIZING` while anything can still be decided, `PARTIAL` only for history that cannot be
 * — never because a checkpoint is merely recent — and `SYNCHRONIZED` only once every required
 * session is recorded.
 *
 * Callers pass only Monitors that are being evaluated; a Monitor that is not running is evaluating
 * nothing and has no synchronization to report.
 */
export async function readMonitorSynchronization(
  prisma: PrismaService,
  monitors: readonly SynchronizationSubject[],
  /** The session the window ends on; by default the canonical one now (`readMonitorActivityWindow`). */
  latestSession?: LocalDate,
): Promise<Map<string, MonitorSynchronizationResponse>> {
  const result = new Map<string, MonitorSynchronizationResponse>();
  if (monitors.length === 0) {
    return result;
  }
  const today =
    latestSession ?? (await latestMonitorSession(prisma, new Date()));
  const windowStart = monitorActivityWindowStart(today);
  const [items, checkpoints] = await Promise.all([
    prisma.stockListItem.findMany({
      where: {
        stockListId: {
          in: [...new Set(monitors.map((monitor) => monitor.stockListId))],
        },
      },
      select: {
        stockListId: true,
        securityId: true,
        buyWindowMode: true,
        buyWindows: { select: { startDate: true, endDate: true } },
      },
    }),
    prisma.monitorEvaluationCheckpoint.findMany({
      where: { monitorId: { in: monitors.map((monitor) => monitor.id) } },
      select: {
        monitorId: true,
        securityId: true,
        configVersion: true,
        evaluatedThrough: true,
        coverageStart: true,
        coverageBlockedFrom: true,
      },
    }),
  ]);

  const itemsByList = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = itemsByList.get(item.stockListId);
    if (bucket) {
      bucket.push(item);
    } else {
      itemsByList.set(item.stockListId, [item]);
    }
  }
  const checkpointOf = new Map(
    checkpoints.map((row) => [`${row.monitorId} ${row.securityId}`, row]),
  );

  for (const monitor of monitors) {
    let currentMembers = 0;
    let coveredMembers = 0;
    let awaitingMembers = 0;
    let completingMembers = 0;
    let historyFrom: LocalDate | undefined;
    for (const item of itemsByList.get(monitor.stockListId) ?? []) {
      const membership = {
        mode: item.buyWindowMode,
        ranges: item.buyWindows.map((window) => ({
          startDate: localDate(window.startDate),
          endDate: window.endDate ? localDate(window.endDate) : null,
        })),
      };
      if (!isOngoingListMember(membership, today)) {
        continue;
      }
      currentMembers += 1;
      const checkpoint = checkpointOf.get(`${monitor.id} ${item.securityId}`);
      if (!checkpoint || checkpoint.configVersion !== monitor.configVersion) {
        awaitingMembers += 1;
        continue;
      }
      const membershipStart = ongoingMembershipStart(membership) ?? null;
      const required =
        membershipStart !== null && membershipStart > windowStart
          ? membershipStart
          : windowStart;
      const recordedFrom = localDate(
        checkpoint.coverageStart ?? checkpoint.evaluatedThrough,
      );
      if (recordedFrom <= required) {
        coveredMembers += 1;
      } else if (checkpoint.coverageBlockedFrom === null) {
        // Its missing sessions have not been decided yet: the worker is completing them.
        completingMembers += 1;
      } else if (historyFrom === undefined || recordedFrom > historyFrom) {
        historyFrom = recordedFrom;
      }
    }
    const passCompleted =
      monitor.watchingSince !== null &&
      monitor.lastScanAt !== null &&
      monitor.lastScanAt.getTime() >= monitor.watchingSince.getTime();
    result.set(monitor.id, {
      state:
        !passCompleted || completingMembers > 0
          ? "SYNCHRONIZING"
          : awaitingMembers > 0 || coveredMembers < currentMembers
            ? "PARTIAL"
            : "SYNCHRONIZED",
      windowStart,
      currentMembers,
      coveredMembers,
      awaitingMembers,
      ...(historyFrom === undefined ? {} : { historyFrom }),
    });
  }
  return result;
}

function localDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}
