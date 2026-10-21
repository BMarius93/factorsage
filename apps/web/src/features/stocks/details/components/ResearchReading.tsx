import { formatLocalDate } from "../utils/format";
import styles from "./ResearchReading.module.css";

type ResearchReadingProps = {
  readonly label: string;
  /** The reading, already formatted in its own unit; `undefined` when there is none. */
  readonly value?: string;
  /**
   * What a row without a value says. "Unavailable" — the default — is a fact about the company: no
   * session of the year has a reading. A section whose readings could not be loaded says
   * "Not loaded" instead, which is a fact about the request.
   */
  readonly emptyLabel?: string;
  /**
   * The session the reading belongs to, given only when it is not the card's own as-of session — so
   * an earlier reading is never presented as the newest session's.
   */
  readonly readingDate?: string;
  /** This series is the one drawn in its chart pane. */
  readonly charted: boolean;
  /** Draws this series' history in its chart pane. */
  readonly onShow: () => void;
  /** The card's one sentence saying what pressing a row does. */
  readonly hintId: string;
  readonly testId?: string;
};

/**
 * One financial reading that opens its own history in the price chart.
 *
 * A native button, so it is reached with Tab and pressed with Enter or Space like any other control,
 * and its accessible name is what it shows: the label, the reading (or "Unavailable") and, for an
 * earlier session, that session. The row the chart is currently drawing says "On chart" in words and
 * is marked `aria-current`, never by colour alone. Pressing it again only brings the chart back into
 * view: there is no toggle-off here — `None` in the chart's `Indicators` control clears a pane.
 */
export function ResearchReading({
  label,
  value,
  emptyLabel = "Unavailable",
  readingDate,
  charted,
  onShow,
  hintId,
  testId,
}: ResearchReadingProps) {
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.reading}
        aria-describedby={hintId}
        aria-current={charted ? "true" : undefined}
        data-testid={testId}
        onClick={onShow}
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.figure}>
          {value === undefined ? (
            <span className={styles.unavailable}>{emptyLabel}</span>
          ) : (
            <span className={styles.value}>{value}</span>
          )}
          {readingDate ? (
            <span className={styles.readingDate}>
              {/* Explicit separator so the name reads "… 21.0x, as of Mar 3, 2026". */}
              <span className={styles.srOnly}>, </span>as of{" "}
              {formatLocalDate(readingDate)}
            </span>
          ) : null}
        </span>
        <span
          className={styles.cue}
          data-charted={charted ? "true" : undefined}
        >
          {charted ? (
            <>
              <span className={styles.srOnly}>, </span>On chart
            </>
          ) : (
            <ChartGlyph />
          )}
        </span>
      </button>
    </li>
  );
}

/** A small line-chart mark: the row's affordance, decoration only. */
function ChartGlyph() {
  return (
    <svg
      className={styles.glyph}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 12.5 6 8l3 2.5L14 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
