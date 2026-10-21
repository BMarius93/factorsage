import type {
  DashboardActivityEventResponse,
  MonitorActivityKind,
  MonitorWhyPredicateResponse,
} from "@intrinsic/contracts";
import { formatEvidenceValue } from "../../monitors/utils/format";

/** The Event filter's choices: every event, or one kind of it, in the product's words. */
export const ACTIVITY_KIND_FILTER_LABELS: Record<MonitorActivityKind, string> =
  {
    ACTIVATED: "Activated",
    RESOLVED: "Ended",
  };

/** One market session's events, newest session first, in the order the API decided. */
export type SessionGroup = {
  /** The exchange session (`YYYY-MM-DD`) the events were observed on. */
  readonly sessionDate: string;
  readonly events: readonly DashboardActivityEventResponse[];
};

/**
 * The feed's events under one heading per market session.
 *
 * Grouped by the event's own `sessionDate` — the exchange session the API recorded, never a date
 * derived from the viewer's clock — and keyed by it, so a session split across two pages (the
 * first page ends mid-session, "Show older activity" continues it) gathers under one heading
 * instead of two. Sessions keep the order they first appear in and events keep the API's order
 * inside them, which is newest session first and then insertion order: nothing is re-sorted, and
 * two events of one stock — two Buy steps, or one stock under two Monitors — stay two events.
 */
export function groupBySession(
  events: readonly DashboardActivityEventResponse[],
): SessionGroup[] {
  const groups = new Map<string, DashboardActivityEventResponse[]>();
  for (const event of events) {
    const group = groups.get(event.sessionDate);
    if (group) {
      group.push(event);
    } else {
      groups.set(event.sessionDate, [event]);
    }
  }
  return [...groups].map(([sessionDate, grouped]) => ({
    sessionDate,
    events: grouped,
  }));
}

/** What a fresh read of the range a reader holds added to it. */
export type RangeArrivals = {
  /** Events above the newest one that was shown: new activity. */
  readonly above: number;
  /** Events among what was shown: written late for a session already on screen. */
  readonly within: number;
};

/**
 * Counts what a re-read of the held range brought that was not shown before: above the newest shown
 * event, or among the shown ones. When the newest shown event is no longer in the range, everything
 * new counts as above.
 */
export function rangeArrivals(
  shown: readonly DashboardActivityEventResponse[],
  range: readonly DashboardActivityEventResponse[],
): RangeArrivals {
  const known = new Set(shown.map((event) => event.id));
  const newest = shown[0]?.id;
  const newestAt =
    newest === undefined ? -1 : range.findIndex((event) => event.id === newest);
  let above = 0;
  let within = 0;
  range.forEach((event, index) => {
    if (known.has(event.id)) return;
    if (newestAt === -1 || index < newestAt) {
      above += 1;
    } else {
      within += 1;
    }
  });
  return { above, within };
}

/**
 * The held list with its range — from the newest event down to `bottomId` — replaced by a fresh read
 * of it. Anything loaded below `bottomId` since the read began (an older page that arrived meanwhile)
 * is kept, in place.
 */
export function replaceRange(
  shown: readonly DashboardActivityEventResponse[],
  range: readonly DashboardActivityEventResponse[],
  bottomId: string,
): DashboardActivityEventResponse[] {
  const at = shown.findIndex((event) => event.id === bottomId);
  return [...range, ...(at >= 0 ? shown.slice(at + 1) : [])];
}

/** Whether a fresh read of the range differs from what is shown of it, by identity and order. */
export function rangeChanged(
  shown: readonly DashboardActivityEventResponse[],
  range: readonly DashboardActivityEventResponse[],
  bottomId: string,
): boolean {
  const at = shown.findIndex((event) => event.id === bottomId);
  const held = at >= 0 ? shown.slice(0, at + 1) : shown;
  return (
    held.length !== range.length ||
    held.some((event, index) => event.id !== range[index]?.id)
  );
}

/**
 * How two recorded operands stand to each other, as arithmetic: `>`, `<`, `=`.
 *
 * It is a statement about the two numbers the decision compared, not the rule's operator — a
 * Condition that required `is above` and failed reads `0.85 < 1.20` beside its ✕, which is exactly
 * why it failed. `vs` where a relation would mislead: an operand that did not resolve, or two values
 * that print the same at display precision while differing underneath.
 */
export function operandRelation(
  left: number | null | undefined,
  right: number | null | undefined,
): ">" | "<" | "=" | "vs" {
  if (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined
  ) {
    return "vs";
  }
  if (left === right) {
    return "=";
  }
  if (formatEvidenceValue(left) === formatEvidenceValue(right)) {
    return "vs";
  }
  return left > right ? ">" : "<";
}

function operand(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "n/a"
    : formatEvidenceValue(value);
}

/**
 * The values one predicate compared, compactly: `42.50 < 55.00`, or for a Trigger the move that
 * crossed — `99.50 → 102.50 > 101.00`. `n/a` where an operand did not resolve. `null` when the
 * decision recorded no values, so nothing is invented to fill the space.
 */
export function predicateComparison(
  predicate: MonitorWhyPredicateResponse,
): string | null {
  if (predicate.result === undefined) {
    return null;
  }
  const now = `${operand(predicate.metric)} ${operandRelation(
    predicate.metric,
    predicate.value,
  )} ${operand(predicate.value)}`;
  return predicate.role === "TRIGGER"
    ? `${operand(predicate.previousMetric)} → ${now}`
    : now;
}
