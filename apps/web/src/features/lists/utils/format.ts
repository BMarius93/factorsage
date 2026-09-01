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
