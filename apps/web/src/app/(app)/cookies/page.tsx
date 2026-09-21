import { legalDocument } from "@intrinsic/contracts";
import { LegalDocumentPage } from "../../../features/legal/components/LegalDocumentPage";
import { StorageSettings } from "../../../features/legal/consent/StorageSettings";

export const metadata = {
  title: `${legalDocument("COOKIES").title} · FactorSage`,
  description: legalDocument("COOKIES").summary,
};

/**
 * `/cookies`. The policy, plus the control that changes the visitor's choice.
 *
 * The inventory table and the settings live on the same page, and the footer's **Storage
 * settings** link points at `#storage-settings`, so withdrawing permission is the same single
 * action as giving it and is never more than one click from anywhere in the product.
 */
export default function CookiesPage() {
  return (
    <LegalDocumentPage kind="COOKIES">
      <StorageSettings />
    </LegalDocumentPage>
  );
}
