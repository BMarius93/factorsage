/**
 * Display formatting for the monitors collection.
 *
 * Stock counts reuse `stockCountLabel` from the lists feature rather than restating the phrase, so
 * a list's size cannot read one way on its own page and another way on a monitor card.
 */

/**
 * The "last checked" line.
 *
 * `lastScanAt` is observability, never an input to Signal semantics — a monitor that has never been
 * included in a cycle says so instead of borrowing its creation time.
 */
export function lastScanLabel(lastScanAt: string | undefined): string {
  if (lastScanAt === undefined) {
    return "Not checked yet";
  }
  const parsed = new Date(lastScanAt);
  if (Number.isNaN(parsed.valueOf())) {
    return `Checked ${lastScanAt}`;
  }
  return `Checked ${parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * How many Signals are currently active.
 *
 * Both condition matches and trigger events are Signals, so there is deliberately one count rather
 * than two — `ai/product/monitors.md` keeps that distinction an explanation, not a second concept.
 */
export function activeSignalLabel(count: number): string {
  if (count === 0) {
    return "No active signals";
  }
  return `${count} active ${count === 1 ? "signal" : "signals"}`;
}
