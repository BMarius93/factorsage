import { formatDate, formatDay } from "../../../lib/dates";

/** "2026-03-04T…" → "Mar 4, 2026" for card metadata. The product's one date format (`lib/dates`). */
export function formatListDate(isoTimestamp: string): string {
  return formatDate(isoTimestamp);
}

export function stockCountLabel(count: number): string {
  return `${count} ${count === 1 ? "stock" : "stocks"}`;
}

/**
 * A canonical `YYYY-MM-DD` membership date, in the product's standard day format: `"Nov 30, 1982"`.
 * A calendar day, so `lib/dates` formats it in UTC — a western timezone would otherwise render the
 * previous day, which for a membership boundary would be a wrong fact, not a cosmetic one.
 */
export function formatMembershipDate(date: string): string {
  return formatDay(date);
}
