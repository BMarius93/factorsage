import type { ValueSpan } from "../../../components/charts/use-value-domain-floor";

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Every calendar day of the configured period, ascending, as `YYYY-MM-DD`.
 *
 * This is what makes a backtest's horizontal axis the whole period from the first render, and it
 * exists because **a Lightweight Charts time scale is ordinal, not continuous**: bars are laid out
 * one index apart whatever the dates on them, so two points thirty years apart are two adjacent
 * bars, not thirty years of axis. A pair of endpoints therefore reserves nothing — the computed
 * prefix simply spreads across the full width and the axis appears to grow a year at a time, which
 * is the behaviour a fixed domain exists to prevent.
 *
 * A day per slot fixes that exactly rather than approximately. Every simulated day the run reports
 * is a calendar day, so it lands *on* a slot rather than between two, and the union of the grid and
 * the curve is the grid itself — which makes a point's position on the axis its position in
 * calendar time, and makes the computed part of the run occupy exactly the fraction of the width it
 * has actually reached.
 *
 * Nothing here is data. Each entry is whitespace — a time with no value — so no scenario gains a
 * point, the value axis is unaffected, and the crosshair has nothing to report on a day the run has
 * not reached. A thirty-year period is about eleven thousand entries, written once.
 */
export function periodCalendarDays(
  periodStart: string,
  periodEnd: string,
): string[] {
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return [];
  }
  const days: string[] = [];
  for (let day = start; day <= end; day += MILLISECONDS_PER_DAY) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Whole months from `from` to `to`, counting a month only once its day-of-month has been reached.
 *
 * This is chart layout arithmetic, not the engine's contribution schedule. Contribution timing is
 * versioned execution methodology that lives in the worker, and nothing here is or may become a
 * second copy of it: the number produced is never displayed, never compared against a result, and
 * only ever decides how tall the value axis starts out.
 */
function wholeMonthsBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  const partial = end.getUTCDate() < start.getUTCDate() ? 1 : 0;
  return Math.max(0, months - partial);
}

/**
 * The span the `Cash` scenario is already known to cover, before a single day is simulated.
 *
 * Cash is `initialCapital + cumulativeContributionsThrough(d)` — non-decreasing by definition — so
 * over the configured period it runs from the initial capital to the initial capital plus every
 * contribution. It is the one line on this chart whose extent does not depend on the simulation,
 * and it is certain to be drawn, which is what makes it a truthful starting extent for the value
 * axis rather than a guess about where the Strategy will end up.
 *
 * It is a floor and nothing more. The real curves widen it the moment they exceed it, and a run
 * whose contributions land on a slightly different cadence than the month count assumed here is
 * corrected by its own first chunk. `null` when the plan says nothing useful — no capital at all.
 */
export function cashScenarioSpan(input: {
  readonly initialCapital: number;
  readonly monthlyContribution: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}): ValueSpan | null {
  const { initialCapital, monthlyContribution, periodStart, periodEnd } = input;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    return null;
  }
  const contributions =
    Number.isFinite(monthlyContribution) && monthlyContribution > 0
      ? monthlyContribution * wholeMonthsBetween(periodStart, periodEnd)
      : 0;
  return { min: initialCapital, max: initialCapital + contributions };
}
