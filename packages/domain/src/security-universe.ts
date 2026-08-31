import type { Security } from "./stock-data.js";

/**
 * The exchanges whose listings this product supports, mapped to the currency they quote in.
 *
 * One table answers both questions on purpose. The bulk provider universe does not carry a
 * currency field, so an exchange this application cannot price in a known currency is an exchange
 * it cannot admit to the catalog. Adding a market later is one line here plus a verified currency.
 *
 * These are all USD-quoted venues, so a foreign issuer listed on them (an ADR, or a Canadian
 * company cross-listed on AMEX) is still correctly USD.
 */
export const SUPPORTED_EXCHANGE_CURRENCIES = {
  NASDAQ: "USD",
  NYSE: "USD",
  AMEX: "USD",
} as const;

export type SupportedExchangeCode = keyof typeof SUPPORTED_EXCHANGE_CURRENCIES;

export const SUPPORTED_EXCHANGE_CODES = Object.keys(
  SUPPORTED_EXCHANGE_CURRENCIES,
) as readonly SupportedExchangeCode[];

/**
 * A candidate row from a bulk provider universe, before this product decides whether it belongs in
 * the `Security` catalog. Deliberately structural: the domain must not depend on a provider package.
 */
export type SecurityListingCandidate = {
  readonly symbol: string;
  readonly name: string;
  /** Short exchange code, matched against {@link SUPPORTED_EXCHANGE_CURRENCIES}. */
  readonly exchangeCode: string;
  readonly exchangeName?: string;
  readonly country?: string;
  readonly sector?: string;
  readonly industry?: string;
  readonly isEtf: boolean;
  readonly isFund: boolean;
  readonly isActivelyTrading: boolean;
};

export const SECURITY_LISTING_REJECTIONS = [
  /** Not an equity: ETF, fund, or any other non-common-stock instrument. */
  "NON_EQUITY",
  /** Listed somewhere this product does not support. */
  "UNSUPPORTED_EXCHANGE",
  /** Missing an identity field the canonical `Security` requires. */
  "INCOMPLETE",
] as const;

export type SecurityListingRejection =
  (typeof SECURITY_LISTING_REJECTIONS)[number];

export type SecurityListingDecision =
  | { readonly supported: true; readonly security: Omit<Security, "id"> }
  | { readonly supported: false; readonly reason: SecurityListingRejection };

/**
 * Decides whether one provider listing belongs in the supported stock universe.
 *
 * Stock-only is enforced from the provider's own `isEtf`/`isFund` flags rather than from a symbol
 * or name heuristic, and crypto/forex/index instruments never reach here because they are not
 * listed on the supported equity exchanges.
 *
 * `isAdr` is not available in a bulk universe response and defaults to `false`; the lazy profile
 * hydration that runs when a stock is actually opened corrects it, along with CIK/ISIN/CUSIP and
 * the IPO date.
 */
export function classifySecurityListing(
  candidate: SecurityListingCandidate,
): SecurityListingDecision {
  const symbol = candidate.symbol.trim().toUpperCase();
  const name = candidate.name.trim();
  const exchangeCode = candidate.exchangeCode.trim().toUpperCase();

  if (symbol === "" || name === "" || exchangeCode === "") {
    return { supported: false, reason: "INCOMPLETE" };
  }
  if (candidate.isEtf || candidate.isFund) {
    return { supported: false, reason: "NON_EQUITY" };
  }

  const currency = SUPPORTED_EXCHANGE_CURRENCIES[
    exchangeCode as SupportedExchangeCode
  ] as string | undefined;
  if (currency === undefined) {
    return { supported: false, reason: "UNSUPPORTED_EXCHANGE" };
  }

  const exchangeName = candidate.exchangeName?.trim();
  const country = candidate.country?.trim();
  const sector = candidate.sector?.trim();
  const industry = candidate.industry?.trim();

  return {
    supported: true,
    security: {
      symbol,
      name,
      exchangeCode,
      ...(exchangeName ? { exchangeName } : {}),
      currency,
      ...(country ? { country } : {}),
      ...(sector ? { sector } : {}),
      ...(industry ? { industry } : {}),
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: candidate.isActivelyTrading,
    },
  };
}

/**
 * The lightweight catalog fields a universe synchronization owns.
 *
 * Everything else on `Security` (CIK, ISIN, CUSIP, IPO date, ADR status) comes only from the
 * per-stock profile, so a catalog sync must never overwrite those with the blanks it has.
 */
export const SECURITY_CATALOG_FIELDS = [
  "symbol",
  "name",
  "exchangeCode",
  "exchangeName",
  "currency",
  "country",
  "sector",
  "industry",
  "type",
  "isActivelyTrading",
] as const satisfies readonly (keyof Omit<Security, "id">)[];

/** True when the synchronized catalog fields differ from what is already persisted. */
export function securityCatalogFieldsChanged(
  persisted: Security,
  incoming: Omit<Security, "id">,
): boolean {
  return SECURITY_CATALOG_FIELDS.some(
    (field) => persisted[field] !== incoming[field],
  );
}
