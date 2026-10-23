import { getEodFinalityConfig } from "@intrinsic/config";
import { monitorActivityWindowStart } from "@intrinsic/contracts";
import { MONITOR_SCAN_SCHEDULE_ID } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import {
  latestFinalizedSession,
  WEEKDAY_TRADING_CALENDAR,
} from "@intrinsic/stock-data";
import type { PrismaService } from "../database/prisma.service";

/** The rolling activity window the Dashboard shows, and the session it ends on. */
export type MonitorActivityWindow = {
  /** The newest finalized session, by the canonical end-of-day policy. */
  latestSession: LocalDate;
  /** Its first calendar day: `latestSession` and the 29 days before it. */
  windowStart: LocalDate;
};

/**
 * The Dashboard's rolling 30-calendar-day window (`docs/decisions/monitor-eod-v2.md` §12.3): it ends
 * on the newest **finalized session** by the canonical end-of-day policy — never on a calendar day,
 * so a weekend or an exchange holiday is never its anchor and the window is the one the Monitor
 * pass evaluated.
 *
 * The policy needs the venue schedule, which comes from the provider; a public read must never
 * reach the provider. So the answer is the one the Monitor pass recorded
 * (`MonitorScanSchedule.latestSession`, asked of the venue schedule every pass), reconciled with
 * the weekday policy, which needs nothing:
 *
 * - the newest finalized weekday is the answer when the pass found the same session;
 * - when the pass, asked **after** that weekday became final, found an earlier one, the weekday is
 *   an exchange holiday and the pass's session is the answer;
 * - otherwise the pass has not asked since that weekday became final (it is starting, or down), and
 *   the weekday is taken to be a session — exactly the policy's own fallback when the venue
 *   schedule cannot be read.
 *
 * One read of one row; no provider request.
 */
export async function readMonitorActivityWindow(
  prisma: PrismaService,
  now: Date,
): Promise<MonitorActivityWindow> {
  const latestSession = await latestMonitorSession(prisma, now);
  return {
    latestSession,
    windowStart: monitorActivityWindowStart(latestSession),
  };
}

export async function latestMonitorSession(
  prisma: PrismaService,
  now: Date,
): Promise<LocalDate> {
  const weekday = await latestFinalizedSession({
    now,
    calendar: WEEKDAY_TRADING_CALENDAR,
    publicationDelayMs: getEodFinalityConfig().publicationDelayMs,
  });
  if (!weekday) {
    // Unreachable: some weekday in any fortnight has closed.
    throw new Error("No finalized weekday session in the last fourteen days");
  }
  const recorded = await prisma.monitorScanSchedule.findUnique({
    where: { id: MONITOR_SCAN_SCHEDULE_ID },
    select: { latestSession: true, latestSessionAt: true },
  });
  if (!recorded?.latestSession || !recorded.latestSessionAt) {
    return weekday.session;
  }
  const session = recorded.latestSession.toISOString().slice(0, 10);
  const askedAt = recorded.latestSessionAt.getTime();
  if (
    session < weekday.session &&
    askedAt >= Date.parse(weekday.finalizedAt) &&
    askedAt <= now.getTime()
  ) {
    return session;
  }
  return weekday.session;
}
