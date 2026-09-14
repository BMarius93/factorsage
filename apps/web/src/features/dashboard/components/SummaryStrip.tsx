import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./SummaryStrip.module.css";

export type SummaryTile = {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: string;
  readonly href?: string;
  /** `action` renders the primary call to action rather than a reported figure. */
  readonly tone?: "default" | "action";
};

/**
 * The row of figures across the top of the dashboard.
 *
 * Every tile is a number the collections already report; none of them is derived from a second
 * request or estimated. A tile with no honest value says so in its own words rather than showing a
 * zero that would read as a measurement.
 */
export function SummaryStrip({
  tiles,
}: {
  readonly tiles: readonly SummaryTile[];
}) {
  return (
    <ul className={styles.strip} data-testid="dashboard-summary">
      {tiles.map((tile) => {
        const body = (
          <>
            <span className={styles.label}>{tile.label}</span>
            <span className={styles.value}>{tile.value}</span>
            {tile.detail ? (
              <span className={styles.detail}>{tile.detail}</span>
            ) : null}
          </>
        );
        return (
          <li key={tile.id} className={styles.item}>
            {tile.href ? (
              <Link
                className={styles.tile}
                data-tone={tile.tone ?? "default"}
                href={tile.href}
              >
                {body}
              </Link>
            ) : (
              <div className={styles.tile} data-tone={tile.tone ?? "default"}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
