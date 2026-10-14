import { getEodFinalityConfig } from "@intrinsic/config";
import { eodCutoffDate, type LocalDate } from "@intrinsic/domain";

/**
 * The newest date whose end-of-day bar is final, by this process's configuration — the date every
 * seed and fixture treats as "today" (`docs/decisions/eod-finality-v1.md`).
 *
 * A seed that wrote a bar for the UTC day while that session was still trading would store exactly
 * what the loader is never allowed to: a provisional bar. Seeding through this date keeps every
 * fixture inside the rule the product enforces.
 */
export function eodToday(now: Date = new Date()): LocalDate {
  return eodCutoffDate(now, getEodFinalityConfig().publicationDelayMs);
}
