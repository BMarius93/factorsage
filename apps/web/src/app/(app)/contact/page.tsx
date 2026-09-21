import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";
import { LegalRequestForm } from "../../../features/legal/components/LegalRequestForm";

export const metadata = {
  title: `${legalDocument("CONTACT").title} · FactorSage`,
  description: legalDocument("CONTACT").summary,
};

/**
 * `/contact`. The operator's identity and the ways to reach them, plus the in-product support
 * channel for a signed-in user.
 */
export default function ContactPage() {
  return (
    <LegalDocumentPage kind="CONTACT">
      <LegalRequestForm kind="SUPPORT" />
    </LegalDocumentPage>
  );
}
