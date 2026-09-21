import { LEGAL_DISCLOSURES } from "@intrinsic/contracts";
import Link from "next/link";
import { SectionCard } from "../../../components/ui/SectionCard";
import styles from "./SubscriptionDisclosure.module.css";

/**
 * The consumer-facing subscription disclosure, on every surface where money is about to move.
 *
 * Rendered on `/pricing` and on `/billing`, from one source, so the two cannot say different
 * things about the same contract.
 *
 * ## What it is for
 *
 * The Consumer Rights Directive asks for the commercial terms to be clear *before* the payment
 * action, and for an unambiguous payment obligation. The plan cards already carry the amount,
 * currency and interval from the shared catalog, and hosted Checkout restates the total before
 * it takes anything; this panel supplies the part that is about rights rather than price, and
 * names the three things people most often confuse.
 *
 * ## What it deliberately does not do
 *
 * It states no refund rule, no withdrawal period and no eligibility test. Whether a statutory
 * right of withdrawal applies to this service, when it starts and ends, and what may lawfully be
 * deducted are outstanding questions for Romanian consumer-law counsel (`O7`) — so the product
 * points at the channel for making the request and says plainly that the rules are being
 * confirmed, rather than asserting an answer it does not have. Inventing one would be the single
 * most consequential thing this work could get wrong.
 *
 * It restates no amount or capacity either: those live in the shared catalog and the entitlement
 * matrix, and a second copy is how a card and a guard end up quoting different numbers.
 */
export function SubscriptionDisclosure() {
  return (
    <SectionCard
      id="subscription-disclosure"
      title="Renewal, cancellation and your consumer rights"
      caption="Three different things, with different rules. Cancelling a renewal is not a refund, and neither is a statutory withdrawal."
      testId="subscription-disclosure"
    >
      <dl className={styles.list}>
        <div className={styles.item}>
          <dt className={styles.term}>Cancelling a renewal</dt>
          <dd className={styles.definition}>
            Stops the next charge. Your access normally continues until the end
            of the period you have already paid for, and the effective date is
            shown before you confirm. It does not by itself return any money. Do
            it in{" "}
            <Link className={styles.link} href="/billing">
              Billing
            </Link>
            .
          </dd>
        </div>
        <div className={styles.item}>
          <dt className={styles.term}>Statutory withdrawal</dt>
          <dd className={styles.definition}>
            Depending on where you live and how this contract is classified, you
            may have a statutory right to withdraw within a period fixed by law.
            You can submit a withdrawal request from{" "}
            <Link className={styles.link} href="/cancellation-and-refunds">
              Cancellation &amp; refunds
            </Link>{" "}
            and you will get an immediate receipt. We are confirming the exact
            rules that apply, so the product records and acknowledges a request
            rather than deciding it — and no right is given up by subscribing.
          </dd>
        </div>
        <div className={styles.item}>
          <dt className={styles.term}>If the service is faulty</dt>
          <dd className={styles.definition}>
            If FactorSage does not do what was agreed or what the law requires
            of it, your remedies are separate from both of the above. They are
            not removed by the renewal policy and they do not expire with a
            withdrawal period.{" "}
            <Link className={styles.link} href="/cancellation-and-refunds">
              Report a problem
            </Link>
            .
          </dd>
        </div>
      </dl>

      <p className={styles.note}>{LEGAL_DISCLOSURES.subscription}</p>
      <p className={styles.note}>
        The full terms are in the{" "}
        <Link className={styles.link} href="/terms">
          Terms of Service
        </Link>
        .
      </p>
    </SectionCard>
  );
}
