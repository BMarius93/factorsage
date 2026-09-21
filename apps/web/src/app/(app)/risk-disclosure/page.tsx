import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";

export const metadata = {
  title: `${legalDocument("RISK_DISCLOSURE").title} · FactorSage`,
  description: legalDocument("RISK_DISCLOSURE").summary,
};

/**
 * `/risk-disclosure`. The full text behind every short contextual disclosure in the product;
 * each `DisclosureNote` links here.
 */
export default function RiskDisclosurePage() {
  return <LegalDocumentPage kind="RISK_DISCLOSURE" />;
}
