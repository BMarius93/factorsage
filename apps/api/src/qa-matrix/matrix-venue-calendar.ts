import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matrixReportRoot } from "./matrix-paths";

/**
 * The venue holiday schedule a matrix sweep is allowed to read: captured once, replayed exactly.
 *
 * Since the weekly rule of `docs/decisions/monitor-eod-v2.md` §9, a week whose last bar is not its
 * Friday is resolved against the venue schedule (`resolveWeekSessionEnds` →
 * `EodFinalityPolicy.isScheduledSession` → `CachedTradingCalendar`), and that schedule is the
 * provider's `holidays-by-exchange`, cached in **process memory** only. Every ETF technical context
 * a backtest builds asks about every holiday week of the fund's history — back to 1993 — so each
 * worker process of a sweep asks the provider for roughly one schedule per year. The matrix counts
 * provider traffic from the `stock-data.provider.request` log line, which the calendar never emits:
 * those requests reached the live provider through the inherited key while the report said zero.
 *
 * A schedule that could not be read is not neutral either: the week is then taken to end on its
 * Friday, so a Good Friday week's weekly values appear one session later than with the schedule. A
 * sweep that silently depended on whether FMP answered would not be reproducible.
 *
 * So the matrix pins it. `pnpm qa:matrix:capture-calendar` (an explicit, opt-in provider read)
 * stores the provider's exact answers for every exchange and year the matrix can ask about, and
 * the runner's provider guard (`matrix-provider-guard.ts`) replays them byte for byte and refuses
 * everything else. The file lives with the other matrix artefacts and is never committed: it is a
 * provider payload.
 */

/** The exchanges the matrix securities and the ETF venue schedule (`NYSE`) trade on. */
export const MATRIX_CALENDAR_EXCHANGES = ["NASDAQ", "NYSE"] as const;

/** The first year any matrix read can reach: the 34-year price retention behind a 30-year run. */
export const MATRIX_CALENDAR_FIRST_YEAR = 1990;

export type PinnedProviderResponse = {
  /** The endpoint, relative to the provider base: `holidays-by-exchange`. */
  readonly path: string;
  /** Every query parameter except the key, which is never stored. */
  readonly query: Readonly<Record<string, string>>;
  readonly status: number;
  /** The response body exactly as the provider sent it. */
  readonly body: string;
};

export type PinnedVenueCalendar = {
  readonly version: 1;
  readonly capturedAt: string;
  readonly responses: readonly PinnedProviderResponse[];
};

/**
 * The request `CachedTradingCalendar.fetchSchedule` makes for one exchange and year: `from` is the
 * provider's exclusive bound (31 December of the year before), `to` the inclusive one.
 */
export function venueCalendarRequest(
  exchange: string,
  year: number,
): { path: string; query: Record<string, string> } {
  return {
    path: "holidays-by-exchange",
    query: {
      exchange: exchange.trim().toUpperCase(),
      from: `${year - 1}-12-31`,
      to: `${year}-12-31`,
    },
  };
}

/** One stable key for a request: path plus its sorted query, without the key. */
export function pinnedRequestKey(
  path: string,
  query: Readonly<Record<string, string>>,
): string {
  const parameters = Object.entries(query)
    .filter(([name]) => name.toLowerCase() !== "apikey")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return `${path.replace(/^\/+/, "")}?${parameters}`;
}

export function venueCalendarPath(root?: string): string {
  return join(matrixReportRoot(root), "pinned-venue-calendar.json");
}

export function readPinnedVenueCalendar(
  path: string,
): PinnedVenueCalendar | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PinnedVenueCalendar;
  if (parsed.version !== 1 || !Array.isArray(parsed.responses)) {
    throw new Error(
      `${path} is not a pinned venue calendar this runner can read.`,
    );
  }
  return parsed;
}

export function writePinnedVenueCalendar(
  path: string,
  calendar: PinnedVenueCalendar,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(calendar, null, 2)}\n`);
}

/** The exchange/year pairs a capture holds a usable (2xx) answer for. */
export function capturedVenueYears(
  calendar: PinnedVenueCalendar,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const response of calendar.responses) {
    if (
      response.path === "holidays-by-exchange" &&
      response.status >= 200 &&
      response.status < 300 &&
      response.query.exchange &&
      response.query.to
    ) {
      covered.add(
        `${response.query.exchange}:${response.query.to.slice(0, 4)}`,
      );
    }
  }
  return covered;
}
