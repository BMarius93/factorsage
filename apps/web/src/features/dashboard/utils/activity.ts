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
