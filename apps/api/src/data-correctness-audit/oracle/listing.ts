/**
 * The listing and pre-listing rules, restated for the oracle rather than imported from
 * `@intrinsic/stock-data`: the audit owns its own reading of the methodology
 * (`docs/decisions/listing-evidence-v1.md`).
 *
 * The listing the stored data evidences is the provider's IPO date, unless the stored price history
 * starts before it — then the first stored bar (DATA-02). There is none without an IPO date.
 */
export function listedFrom(
  ipoDate: string | null | undefined,
  firstStoredBar: string | null | undefined,
): string | null {
  if (!ipoDate) {
    return null;
  }
  return firstStoredBar && firstStoredBar < ipoDate ? firstStoredBar : ipoDate;
}

/**
 * DATA-03 (owner ruling of 2026-10-16, option C): a statement whose period ended before the listing
 * counts only when the provider dates its filing after the period end. A period-end "filing" date
 * is a placeholder, and no evidence that the figures were public before the company listed.
 */
export function evidencedBeforeListing(
  row: { fiscalDate: string; filingDate: string },
  listing: string | null,
): boolean {
  return (
    listing === null ||
    row.fiscalDate >= listing ||
    row.filingDate > row.fiscalDate
  );
}
