import type { ReactNode } from "react";
import styles from "./FactGrid.module.css";

export type Fact = {
  readonly label: string;
  readonly value: ReactNode;
  readonly testId?: string;
};

type FactGridProps = {
  readonly facts: readonly Fact[];
  /** Minimum column width; the grid fits as many columns as the container allows. */
  readonly minColumnWidth?: string;
  readonly testId?: string;
};

/**
 * A labelled set of read-only facts: a monitor's configuration, a backtest's run parameters, a
 * list's counts.
 *
 * Five surfaces each had their own `facts`/`fact`/`factLabel`/`factValue` block, at three different
 * label sizes. This is the one of them. It is deliberately not a table: these are the properties of
 * a single entity, not a collection — a collection belongs in `DataTable`.
 */
export function FactGrid({
  facts,
  minColumnWidth = "180px",
  testId,
}: FactGridProps) {
  return (
    <dl
      className={styles.grid}
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minColumnWidth}), 1fr))`,
      }}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {facts.map((fact) => (
        <div key={fact.label} className={styles.fact}>
          <dt className={styles.label}>{fact.label}</dt>
          <dd
            className={styles.value}
            {...(fact.testId ? { "data-testid": fact.testId } : {})}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
