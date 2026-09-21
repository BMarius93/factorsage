import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";

export const metadata = {
  title: `${legalDocument("TERMS").title} · FactorSage`,
  description: legalDocument("TERMS").summary,
};

/**
 * `/terms`. A server component over the versioned registry: no API call, no session, so it
 * renders for a Guest, for an expired session and for somebody who has declined the Terms.
 */
export default function TermsPage() {
  return <LegalDocumentPage kind="TERMS" />;
}
