import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";

export const metadata = {
  title: `${legalDocument("PRIVACY").title} · FactorSage`,
  description: legalDocument("PRIVACY").summary,
};

/** `/privacy`. Information, not a consent — see the document's own first section. */
export default function PrivacyPage() {
  return <LegalDocumentPage kind="PRIVACY" />;
}
