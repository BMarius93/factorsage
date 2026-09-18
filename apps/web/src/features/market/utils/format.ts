import type { MarketOverviewItemResponse } from "@intrinsic/contracts";

/**
 * How an index level reads.
 *
 * Two rules, because two very different magnitudes share one card family: a four- or five-figure
 * index is read as a whole number with thousands separators — `7,637`, `51,778` — where two decimal
 * places would be noise nobody tracks, while `VIX` at `15.43` is watched to the hundredth and
 * rounding it to `15` would throw away the part that moves.
 */
export function formatMarketValue(value: number): string {
  const fractionDigits = Math.abs(value) >= 1000 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/** `+1.13%`, `-12.87%`. Always signed: the direction is the point. */
export function formatChangePercent(percent: number): string {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(percent));
  return `${percent >= 0 ? "+" : "−"}${formatted}%`;
}

export type MarketChangeTone = "positive" | "negative" | "flat";

export function changeTone(percent: number | undefined): MarketChangeTone {
  if (percent === undefined || percent === 0) {
    return "flat";
  }
  return percent > 0 ? "positive" : "negative";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * The session a value closed on, as `17 Sep`.
 *
 * Read in UTC, not the reader's zone: the session is a calendar date the exchange decided, not an
 * instant, and rendering `2026-09-17` locally turns it into `16 Sep` for anybody west of Greenwich.
 *
 * The month names are a fixed table rather than `Intl`, because this string ends up in screenshots
 * and in assertions: ICU renders September as `Sep` in one runtime and `Sept` in the next, and a
 * pill that changes width between Node versions is not a thing to debug twice.
 */
export function formatSessionDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return date;
  }
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()] as string}`;
}

/**
 * What a screen reader is told about a card.
 *
 * Built from the numbers, never from the sparkline: the chart is `aria-hidden` and decorative, and
 * a reader who cannot see it must still get the level, the direction and — the part that is easy to
 * leave out — that this is a close rather than a live quote.
 */
export function marketCardDescription(
  item: MarketOverviewItemResponse,
): string {
  if (item.status === "UNAVAILABLE" || item.value === undefined) {
    return `${item.label}: no recent data available.`;
  }
  const session = item.sessionDate
    ? ` at the close on ${formatSessionDate(item.sessionDate)}`
    : "";
  const change =
    item.changePercent === undefined
      ? ""
      : `, ${item.changePercent >= 0 ? "up" : "down"} ${new Intl.NumberFormat(
          "en-US",
          { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        ).format(Math.abs(item.changePercent))}% on the previous session`;
  return `${item.label}: ${formatMarketValue(item.value)}${session}${change}.`;
}
