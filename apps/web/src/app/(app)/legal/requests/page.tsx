import { PageContainer } from "../../../../components/layout/PageContainer";
import { PageHeader } from "../../../../components/ui/PageHeader";
import pageStyles from "../../../../components/ui/page.module.css";
import { LegalRequestForm } from "../../../../features/legal/components/LegalRequestForm";
import { LegalRequestHistory } from "../../../../features/legal/components/LegalRequestHistory";

export const metadata = {
  title: "Privacy and data requests · FactorSage",
  description:
    "Ask for access to your personal data, its correction or erasure, a portable copy, or to object to processing.",
};

/**
 * `/legal/requests`. The data-protection channel, and the account's own receipts.
 *
 * Reachable while a Terms acceptance is outstanding — on the server as well as in the UI —
 * because exercising a data-protection right must never depend on agreeing to a contract.
 */
export default function LegalRequestsPage() {
  return (
    <PageContainer width="reading">
      <div className={pageStyles.stack}>
        <PageHeader
          title="Privacy and data requests"
          lead="Ask for access, correction, erasure, restriction, a portable copy, or to object to processing. Submitting from your signed-in account is how we identify you."
          variant="plain"
          testId="legal-requests"
        />
        <LegalRequestForm kind="PRIVACY_REQUEST" />
        <LegalRequestHistory />
      </div>
    </PageContainer>
  );
}
