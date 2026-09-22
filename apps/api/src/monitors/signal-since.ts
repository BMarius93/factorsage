import { tradingSessionCloseInstant, type LocalDate } from "@intrinsic/domain";

/**
 * When a Monitor state began, as the instant a reader should be shown.
 *
 * A lifecycle row records two different things about its beginning: the **observation** it was
 * decided on (`lifecycleSinceDate`, a session), and the **write** that persisted it
 * (`lifecycleSince`, a wall clock). The Dashboard's "Since" and the Monitor detail page's "waiting
 * since" are statements about the first. Rendering the second dates a historically reconstructed
 * Signal to the scan that discovered it — the Dashboard showed a 49-day-old match as minutes old
 * (AUD-05).
 *
 * The rule is the earlier of the two:
 *
 * - a state entered on a **closed** session began at that session's close, which is before the scan
 *   that observed it. A reconstruction is this case however long after the fact it runs;
 * - a state entered on the session **in progress** began when the scan saw it, which is before that
 *   session's close. Dating it at the close would put "since" in the future.
 *
 * Both timestamps stay in the database: `lifecycleSince` remains the write's own record, and the
 * worker keeps stamping it with its clock. This is a read-edge projection, not a re-definition of
 * either column, and it never claims a precision the data does not have — the close is the session's
 * own boundary, not a guess at the minute a condition turned true.
 */
export function monitorStateSince(state: {
  /** The session the state was entered on, if one was recorded. */
  readonly observationDate: Date | null;
  /** The instant the state was persisted. */
  readonly enteredAt: Date;
}): string {
  if (state.observationDate === null) {
    // Rows written before the observation date was recorded have only the write instant to offer.
    return state.enteredAt.toISOString();
  }
  const close = tradingSessionCloseInstant(
    state.observationDate.toISOString().slice(0, 10) as LocalDate,
  );
  return (close < state.enteredAt ? close : state.enteredAt).toISOString();
}
