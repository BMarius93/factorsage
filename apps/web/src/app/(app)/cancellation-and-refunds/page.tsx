import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";
import { LegalRequestForm } from "../../../features/legal/components/LegalRequestForm";
import { SubscriptionSummary } from "../../../features/legal/components/SubscriptionSummary";

export const metadata = {
  title: `${legalDocument("CANCELLATION_AND_REFUNDS").title} · FactorSage`,
  description: legalDocument("CANCELLATION_AND_REFUNDS").summary,
};

/**
 * `/cancellation-and-refunds`.
 *
 * The page keeps the three operations apart in the order somebody actually needs them:
 *
 * 1. the policy text, which explains why they are different;
 * 2. the subscription this account holds, so a withdrawal request identifies a real contract
 *    rather than an abstraction — and so the *cancel a renewal* path is one click away, in
 *    Billing, where it belongs;
 * 3. the online withdrawal function;
 * 4. the nonconformity channel, which is separate and does not expire with a withdrawal period.
 *
 * Cancelling a renewal is deliberately **not** a form here. It is a billing action, it already
 * exists in the hosted customer portal reached from Billing, and duplicating it on this page is
 * exactly how somebody ends up believing they have exercised a statutory right when they have
 * stopped a renewal, or the reverse.
 */
export default function CancellationAndRefundsPage() {
  return (
    <LegalDocumentPage kind="CANCELLATION_AND_REFUNDS">
      <SubscriptionSummary />
      <LegalRequestForm kind="WITHDRAWAL" />
      <LegalRequestForm kind="NONCONFORMITY" />
    </LegalDocumentPage>
  );
}
