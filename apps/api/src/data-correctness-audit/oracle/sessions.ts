/**
 * Session clocks, written from the product rule alone.
 *
 * The supported venues (NASDAQ, NYSE, AMEX) all run 09:30–16:00 America/New_York, so a session
 * named by its date closed at 16:00 that day in that zone. The audit needs the instant to check the
 * Dashboard's "Since", which is a statement about an observation rather than about a database write
 * (AUD-05).
 *
 * The search over the two possible offsets is deliberately a different algorithm from the product's
 * (which resolves the zone offset and corrects it once): an oracle that reproduced the
 * implementation would prove nothing.
 */

const NEW_YORK_WALL_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function wallClock(instant: Date): string {
  const parts = NEW_YORK_WALL_CLOCK.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** The ISO instant at which the session named by `date` closed. */
export function oracleSessionClose(date: string): string {
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(
      `${date}T${String(16 + offsetHours).padStart(2, "0")}:00:00.000Z`,
    );
    if (wallClock(candidate) === `${date} 16:00`) {
      return candidate.toISOString();
    }
  }
  throw new Error(`No 16:00 New York instant exists for \`${date}\`.`);
}
