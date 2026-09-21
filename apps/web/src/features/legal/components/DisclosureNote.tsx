import {
  LEGAL_DISCLOSURES,
  type LegalDisclosureId,
} from "@intrinsic/contracts";
import Link from "next/link";
import styles from "./DisclosureNote.module.css";

/**
 * The one contextual disclosure component.
 *
 * Every surface that needs one — the Dashboard's signals, a Monitor's detail, a backtest result,
 * a stock's valuation — renders this with an id from `LEGAL_DISCLOSURES`, so there is one copy of
 * each sentence in the product rather than four that slowly diverge.
 *
 * Deliberately quiet: a hairline rule and secondary text under the thing it is about, not a
 * warning banner. A disclosure that shouts on every screen is a disclosure people stop reading,
 * and these are statements of fact about what the numbers above are — not alarms.
 *
 * Every one links to the full Risk Disclosure, because the short sentence is a summary of that
 * document and must be traceable to it.
 */
export function DisclosureNote({
  id,
  className,
}: {
  readonly id: LegalDisclosureId;
  /** Lets a feature place the note inside its own layout without a wrapper element. */
  readonly className?: string;
}) {
  return (
    <p
      className={className ? `${styles.note} ${className}` : styles.note}
      data-testid={`disclosure-${id}`}
    >
      {LEGAL_DISCLOSURES[id]}{" "}
      <Link className={styles.link} href="/risk-disclosure">
        Read the Risk Disclosure
      </Link>
      .
    </p>
  );
}
