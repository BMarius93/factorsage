/** "2026-03-04T…" → "Mar 4, 2026" for card metadata; falls back to the raw value if unparsable. */
export function formatListDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.valueOf())) {
    return isoTimestamp;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function stockCountLabel(count: number): string {
  return `${count} ${count === 1 ? "stock" : "stocks"}`;
}

/**
 * A canonical `YYYY-MM-DD` membership date, in the product's standard day format.
 *
 * Matches `formatDay` in the backtests feature and `formatLocalDate` in Stock Details: `"Nov 30,
 * 1982"`. Canonical dates parse to UTC midnight, so the formatter stays in UTC or a western
 * timezone would render the previous day — which for a membership boundary would be a wrong fact,
 * not a cosmetic one.
 */
const membershipDayFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** `"1982-11-30"` → `"Nov 30, 1982"`. Returns the raw value when it is not a parseable date. */
export function formatMembershipDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf())
    ? date
    : membershipDayFormat.format(parsed);
}
