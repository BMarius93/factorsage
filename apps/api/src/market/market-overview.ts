import type {
  MarketOverviewItemResponse,
  MarketOverviewPoint,
} from "@intrinsic/contracts";
import { MARKET_OVERVIEW_SPARKLINE_SESSIONS } from "@intrinsic/contracts";
import type { BenchmarkDailyPrice } from "@intrinsic/domain";

/**
 * How far back one overview read asks for.
 *
 * Calendar days, because that is the only unit a date range has; sessions are what comes back. It
 * is sized so the {@link MARKET_OVERVIEW_SPARKLINE_SESSIONS} most recent sessions are inside it
 * even across a holiday week, and no further: this window is what the loader hydrates on a cold
 * series, and the Dashboard has no use for a deeper history it would never draw. Deeper history is
 * a prewarm decision (`pnpm benchmarks:prewarm`), not something a page read decides for itself.
 *
 * It is not a claim about how much history the provider has. Coverage stays provider-driven — a
 * series whose own history starts later simply returns fewer sessions.
 */
export const MARKET_OVERVIEW_LOOKBACK_DAYS = 30;

/**
 * One card's numbers, derived from the sessions the loader returned.
 *
 * Pure on purpose: every rule worth getting wrong here — what "previous close" means, when a
 * percentage may not be stated, what "7 days" counts — is decided in this function and tested
 * without a database, a provider or a clock.
 *
 * The rules:
 *
 * - the latest **session**, never "today". A read on a Sunday reports Friday's close and says so
 *   with `sessionDate`, rather than presenting a two-day-old number as current;
 * - the change compares two adjacent observed sessions. Wall-clock arithmetic would make the
 *   number meaningless over a weekend and outright wrong over a holiday;
 * - fewer than two observations yields **no** percentage. Zero would be a claim the data does not
 *   support;
 * - the trend line is the last seven observed sessions, oldest first. Padding weekends in would
 *   draw flat segments the market never had.
 */
export function buildMarketOverviewItem(
  code: string,
  label: string,
  rows: readonly BenchmarkDailyPrice[],
): MarketOverviewItemResponse {
  const sessions = [...rows]
    .filter((row) => Number.isFinite(row.close))
    .sort((left, right) => left.date.localeCompare(right.date));

  const latest = sessions.at(-1);
  if (!latest) {
    return unavailableMarketOverviewItem(code, label);
  }

  const previous = sessions.at(-2);
  const sparkline: MarketOverviewPoint[] = sessions
    .slice(-MARKET_OVERVIEW_SPARKLINE_SESSIONS)
    .map((row) => ({ date: row.date, value: row.close }));

  return {
    code,
    label,
    status: "AVAILABLE",
    value: latest.close,
    sessionDate: latest.date,
    ...(previous && previous.close !== 0
      ? {
          previousClose: previous.close,
          changePercent:
            ((latest.close - previous.close) / previous.close) * 100,
        }
      : {}),
    sparkline,
  };
}

/**
 * A card with nothing to show.
 *
 * Its own shape rather than an omitted item, so the Dashboard still renders five cards in the same
 * order when one series is temporarily unreadable, and renders that one as unavailable instead of
 * silently shrinking the row or showing a number it does not have.
 */
export function unavailableMarketOverviewItem(
  code: string,
  label: string,
): MarketOverviewItemResponse {
  return { code, label, status: "UNAVAILABLE", sparkline: [] };
}
