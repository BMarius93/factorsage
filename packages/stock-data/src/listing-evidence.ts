import { hasProviderFilingDate, type LocalDate } from "@intrinsic/domain";
import { startOfIsoWeek } from "./weekly.js";

/**
 * Where the stored data says a security's listing begins (pre-release audit 2026-10-16, DATA-02).
 *
 * The provider's IPO date is evidence of a listing only while the stored price history agrees with
 * it. FMP dates some long-listed companies' IPO years after bars it serves for them — `NEE` (FPL
 * Group until 2010) at 2014-06-19 though it trades from 1992, `HON` at 2001-02-21 though FMP serves
 * its bars from 1996 — and a traded bar is direct evidence of a listing. So the floor is the earlier
 * of the two: `min(ipoDate, first stored bar)`. Without an IPO date there is no listing evidence and
 * no floor, exactly as before.
 *
 * The floor never cuts stored data: prices, statements and frames are bounded by the retention
 * horizon alone. It answers which financial statements predate the listing
 * ({@link statementsWithEvidencedAvailability}, DATA-03) and where Stock Details says the security
 * starts.
 */
export function listingFloor(input: {
  readonly ipoDate?: LocalDate | undefined;
  readonly earliestPriceDate?: LocalDate | null | undefined;
}): LocalDate | undefined {
  const { ipoDate, earliestPriceDate } = input;
  if (ipoDate === undefined) {
    return undefined;
  }
  return earliestPriceDate && earliestPriceDate < ipoDate
    ? earliestPriceDate
    : ipoDate;
}

/**
 * The provider's IPO date falls in a later week than a bar the stock is stored as having traded: it
 * is not the listing at all, and is logged as a provider anomaly.
 *
 * Week-granular on purpose. An IPO date a session or two after the first bar is the provider dating
 * the same listing a little differently (`CAVA`'s first stored session is 2023-06-15, its IPO date
 * 2023-06-16) — still the listing week, and still a listing.
 */
export function listingDateContradicted(input: {
  readonly ipoDate?: LocalDate | undefined;
  readonly earliestPriceDate?: LocalDate | null | undefined;
}): boolean {
  const { ipoDate, earliestPriceDate } = input;
  return (
    ipoDate !== undefined &&
    Boolean(earliestPriceDate) &&
    (earliestPriceDate as LocalDate) < startOfIsoWeek(ipoDate)
  );
}

/**
 * Whether a calculation whose first bar is `historyStart` begins at the listing — so a partial
 * first week is a real listing week, kept like any other — rather than at a horizon or provider
 * boundary that cut a week in half.
 *
 * As before, an IPO date on or after the first bar says so; now only when it falls in that bar's
 * week. An IPO date weeks or years after the first bar is contradicted by it (`NEE`: 2014 against
 * bars from 1992): the history starts wherever the retention or the provider's data started, and
 * its first week is treated as cut.
 */
export function startsAtListing(input: {
  readonly ipoDate?: LocalDate | undefined;
  readonly historyStart: LocalDate;
}): boolean {
  return (
    input.ipoDate !== undefined &&
    input.ipoDate >= input.historyStart &&
    startOfIsoWeek(input.ipoDate) === startOfIsoWeek(input.historyStart)
  );
}

/**
 * The statement revisions a calculation may read (DATA-03, owner ruling of 2026-10-16).
 *
 * *"Only use pre-listing financial statements when there is reliable evidence of genuine public
 * availability. Placeholder publication dates are not sufficient."* A revision whose fiscal period
 * ended before the listing floor counts only when the provider holds a real filing date for it
 * (`hasProviderFilingDate`: a filing date after the period end — a prospectus, or a later filing
 * that reports the period). Its availability is then that filing plus a day, as for any statement.
 * A placeholder — the statutory deadline `statementPublicAvailabilityDate` assigns when the
 * provider's filing date is the period end — stands for a filing obligation a company that had not
 * listed did not have, so it is no evidence: such a revision is never read.
 *
 * Revisions from the floor on, and every revision of a security with no floor, are read exactly as
 * before. Applied wherever statements feed a calculation — Fundamental Metrics, intrinsic values and
 * valuation ratios — so they all start from the same filings.
 */
export function statementsWithEvidencedAvailability<
  T extends { readonly fiscalDate: LocalDate; readonly filingDate: LocalDate },
>(statements: readonly T[], floor: LocalDate | undefined): T[] {
  if (floor === undefined) {
    return [...statements];
  }
  return statements.filter(
    (statement) =>
      statement.fiscalDate >= floor || hasProviderFilingDate(statement),
  );
}
