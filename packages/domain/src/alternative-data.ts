import type { LocalDate, SecurityId } from "./stock-data.js";

/**
 * Alternative-data domain vocabulary: insider Form 4 activity and congressional disclosures.
 *
 * `docs/alternative-data-signals.md` is the product decision this file implements. Everything here
 * is pure normalization of provider facts into product enums, plus the one point-in-time rule the
 * whole slice depends on. No I/O, no clock, no provider knowledge: the FMP field names live in
 * `@intrinsic/fmp`, the persistence in `@intrinsic/database`, and the metric semantics in
 * `@intrinsic/contracts`.
 *
 * Two rules run through all of it:
 *
 * 1. **Raw provider facts are preserved beside the normalized value.** A normalizer never destroys
 *    what the provider said — an unrecognized Form 4 code becomes `OTHER` and the raw string is
 *    stored beside it — because a category this product invents must never be mistaken for a
 *    disclosure the source made.
 * 2. **Precision is never invented.** A congressional amount is a *range*; its bounds are stored
 *    and a midpoint is never computed as though it were a fact.
 */

// ---------------------------------------------------------------------------
// Point-in-time availability
// ---------------------------------------------------------------------------

function addCalendarDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The first calendar date on which a publicly filed disclosure may influence a historical decision.
 *
 * It is the publication date **plus one day**, which is exactly the rule
 * `statementPublicAvailabilityDate` already applies to a financial statement with a real filing
 * date, and it is chosen for the same reason: the provider supplies a filing *date* and no time, so
 * nothing proves the document was public before that session's close. Crediting the filing date
 * itself would let a backtest act on information it cannot prove it had.
 *
 * The *session* a strategy first reads it on is a separate question and is answered by the
 * evaluation frame's own date axis — the first trading session on or after this date. That is what
 * makes weekends and exchange holidays correct without this function knowing a calendar.
 *
 * @param publicationDate a Form 4 `filingDate`, or a congressional `disclosureDate`.
 */
export function alternativeDataAvailabilityDate(
  publicationDate: LocalDate,
): LocalDate {
  return addCalendarDays(publicationDate, 1);
}

// ---------------------------------------------------------------------------
// Canonical actors
// ---------------------------------------------------------------------------

export const CONGRESS_CHAMBERS = ["HOUSE", "SENATE"] as const;
export type CongressChamber = (typeof CONGRESS_CHAMBERS)[number];

/**
 * One canonical actor: in V1, a member of Congress.
 *
 * `externalId` is the identity — a member's bioguide id — and `displayName` is a label. Two members
 * can share a display name and one member's name can change; neither may move a group's membership,
 * which is why nothing in this slice keys an actor by name.
 *
 * Insider persons are deliberately **not** actors: `docs/alternative-data-signals.md` keeps insider
 * person groups out of V1, and an insider metric counts distinct reporting CIKs straight off the
 * transaction rows. Giving them actor rows would create identities nothing selects. There is
 * correspondingly no actor-kind discriminator: one would have exactly one value, which is a
 * distinction the product does not yet make.
 */
export type AlternativeDataActor = {
  id: string;
  externalId: string;
  displayName: string;
  chamber: CongressChamber;
  /** The two-letter state, where the provider reports one. */
  state?: string;
  /** The provider's district string, e.g. `TX17`. Senate rows carry none. */
  district?: string;
};

// ---------------------------------------------------------------------------
// Insider activity
// ---------------------------------------------------------------------------

/**
 * What one Form 4 line actually was.
 *
 * SEC Form 4 carries a single-letter transaction code and the provider renders it as
 * `"<code>-<label>"` (`"P-Purchase"`, `"S-Sale"`, `"M-Exempt"`). Only `P` and `S` are discretionary
 * open-market trades; an award, a gift, an option exercise or a tax withholding is not a decision to
 * buy or sell at the market price, and treating one as a purchase is the single most common way an
 * insider signal is made meaningless.
 */
export const INSIDER_TRANSACTION_CATEGORIES = [
  "OPEN_MARKET_PURCHASE",
  "OPEN_MARKET_SALE",
  "AWARD",
  "GIFT",
  "OPTION_EXERCISE",
  "CONVERSION",
  "DISPOSITION_TO_ISSUER",
  "OTHER",
] as const;

export type InsiderTransactionCategory =
  (typeof INSIDER_TRANSACTION_CATEGORIES)[number];

/**
 * Form 4 transaction codes this product classifies, keyed by the code letter itself.
 *
 * Codes absent from this table — `E`, `H`, `I`, `L`, `O`, `U`, `W`, `Z`, `J`, `K` and anything the
 * SEC adds later — resolve to `OTHER`. That is deliberate: every one of them is either a
 * non-discretionary or an exotic transaction, and inventing a category for it would put a guess
 * where the source gave none.
 */
const INSIDER_CODE_CATEGORIES: Readonly<
  Record<string, InsiderTransactionCategory>
> = {
  P: "OPEN_MARKET_PURCHASE",
  S: "OPEN_MARKET_SALE",
  A: "AWARD",
  G: "GIFT",
  M: "OPTION_EXERCISE",
  X: "OPTION_EXERCISE",
  C: "CONVERSION",
  D: "DISPOSITION_TO_ISSUER",
  F: "DISPOSITION_TO_ISSUER",
};

/**
 * The leading Form 4 code letter of a provider transaction type, or `undefined` when there is none.
 *
 * The provider's own string is the raw fact and is stored unchanged; this reads the code out of it
 * so classification depends on the SEC's code rather than on the provider's label text.
 */
export function insiderTransactionCode(
  providerTransactionType: string,
): string | undefined {
  const trimmed = providerTransactionType.trim().toUpperCase();
  const code = /^([A-Z])(?:-|$)/.exec(trimmed)?.[1];
  return code ?? undefined;
}

export function classifyInsiderTransaction(
  providerTransactionType: string,
): InsiderTransactionCategory {
  const code = insiderTransactionCode(providerTransactionType);
  return (code ? INSIDER_CODE_CATEGORIES[code] : undefined) ?? "OTHER";
}

/** Whether a category is a discretionary trade at the market price. */
export function isOpenMarketInsiderTrade(
  category: InsiderTransactionCategory,
): boolean {
  return (
    category === "OPEN_MARKET_PURCHASE" || category === "OPEN_MARKET_SALE"
  );
}

/**
 * Insider roles this product can filter on.
 *
 * Derived from the provider's free-text `typeOfOwner` ("officer: SVP, GC and Government Affairs",
 * "director", "10 percent owner"), so the set is deliberately coarse: it names only the roles the
 * text states plainly enough to be worth filtering on. `OFFICER` is the catch-all for an officer
 * whose title is not one of the named ones, so a role filter never silently drops an officer.
 */
export const INSIDER_ROLES = [
  "CEO",
  "CFO",
  "COO",
  "PRESIDENT",
  "CHAIRMAN",
  "DIRECTOR",
  "OFFICER",
  "TEN_PERCENT_OWNER",
  "OTHER",
] as const;

export type InsiderRole = (typeof INSIDER_ROLES)[number];

/**
 * Every role one `typeOfOwner` string states, in canonical order.
 *
 * A person is frequently more than one thing — "officer: President and CEO", "director, 10 percent
 * owner" — so this returns a set rather than a single value, and a role filter matches when any of
 * them is selected. An officer whose title matches no named role still carries `OFFICER`; a string
 * that states nothing recognizable carries `OTHER`, never an empty list, so the row is always
 * addressable.
 */
export function insiderRolesOf(
  typeOfOwner: string | undefined,
): InsiderRole[] {
  const text = (typeOfOwner ?? "").toLowerCase();
  if (text.trim().length === 0) {
    return ["OTHER"];
  }
  const roles = new Set<InsiderRole>();
  const isOfficer = text.includes("officer");
  // Titles are matched on the whole string rather than only after "officer:", because the provider
  // is inconsistent about the prefix and a bare "chief executive officer" is still a CEO.
  if (/\bceo\b|chief executive/.test(text)) {
    roles.add("CEO");
  }
  if (/\bcfo\b|chief financial/.test(text)) {
    roles.add("CFO");
  }
  if (/\bcoo\b|chief operating/.test(text)) {
    roles.add("COO");
  }
  if (/\bpresident\b/.test(text)) {
    roles.add("PRESIDENT");
  }
  if (/\bchairman\b|\bchair\b/.test(text)) {
    roles.add("CHAIRMAN");
  }
  if (/\bdirector\b/.test(text)) {
    roles.add("DIRECTOR");
  }
  if (/10\s*(?:percent|%)|ten\s*percent/.test(text)) {
    roles.add("TEN_PERCENT_OWNER");
  }
  if (isOfficer) {
    roles.add("OFFICER");
  }
  if (roles.size === 0) {
    roles.add("OTHER");
  }
  return INSIDER_ROLES.filter((role) => roles.has(role));
}

/**
 * One normalized insider transaction, as it is persisted and evaluated.
 *
 * `transactionDate` and `filingDate` are both kept and are **different facts**;
 * `availableFromDate` is derived from the filing date alone. `transactionValue` is present only when
 * the provider supplied both a share count and a price — an award priced at `0` yields no value
 * rather than a value of zero.
 */
export type InsiderTransactionFact = {
  securityId: SecurityId;
  transactionDate: LocalDate;
  filingDate: LocalDate;
  availableFromDate: LocalDate;
  reportingCik: string;
  reportingName: string;
  companyCik?: string;
  typeOfOwner?: string;
  roles: readonly InsiderRole[];
  /** The SEC code letter, when the provider's string carried one. */
  transactionCode?: string;
  /** The provider's own transaction type string, unchanged. */
  transactionType: string;
  category: InsiderTransactionCategory;
  acquisitionOrDisposition?: string;
  directOrIndirect?: string;
  formType?: string;
  securityName?: string;
  securitiesTransacted?: number;
  securitiesOwned?: number;
  price?: number;
  transactionValue?: number;
  sourceUrl?: string;
};

/**
 * The transacted value of one line, or `undefined` when the provider did not supply both factors.
 *
 * A zero or absent price is not a $0 trade: it is an award, a gift or an exercise whose price the
 * form does not state. Reporting `0` would make a `purchase value` metric read as a real, tiny
 * purchase.
 */
export function insiderTransactionValue(input: {
  securitiesTransacted?: number;
  price?: number;
}): number | undefined {
  const { securitiesTransacted, price } = input;
  if (
    securitiesTransacted === undefined ||
    price === undefined ||
    !Number.isFinite(securitiesTransacted) ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return undefined;
  }
  return Math.abs(securitiesTransacted) * price;
}

// ---------------------------------------------------------------------------
// Congressional trading
// ---------------------------------------------------------------------------

export const CONGRESS_TRANSACTION_KINDS = [
  "PURCHASE",
  "SALE",
  "EXCHANGE",
  "OTHER",
] as const;

export type CongressTransactionKind =
  (typeof CONGRESS_TRANSACTION_KINDS)[number];

/**
 * Normalizes a disclosure's transaction type.
 *
 * The filings say `"Purchase"`, `"Sale"`, `"Sale (Full)"`, `"Sale (Partial)"`, `"Exchange"` and
 * occasionally something else. A partial and a full sale are both sales — the product does not
 * claim to know what fraction of a holding moved — and anything unrecognized stays `OTHER` with the
 * raw string beside it.
 */
export function classifyCongressTransaction(
  providerType: string,
): CongressTransactionKind {
  const text = providerType.trim().toLowerCase();
  if (text.startsWith("purchase")) {
    return "PURCHASE";
  }
  if (text.startsWith("sale") || text.startsWith("sell")) {
    return "SALE";
  }
  if (text.startsWith("exchange")) {
    return "EXCHANGE";
  }
  return "OTHER";
}

export const CONGRESS_OWNERS = [
  "SELF",
  "SPOUSE",
  "JOINT",
  "CHILD",
  "DEPENDENT",
  "OTHER",
  "UNSPECIFIED",
] as const;

export type CongressOwner = (typeof CONGRESS_OWNERS)[number];

/**
 * Normalizes the disclosed owner.
 *
 * `UNSPECIFIED` is what an empty provider field becomes, and it is **not** the same as `SELF`: a
 * filing that names no owner has not said the member holds it personally. An owner filter therefore
 * never quietly folds unspecified rows into `SELF`.
 */
export function classifyCongressOwner(
  providerOwner: string | undefined,
): CongressOwner {
  const text = (providerOwner ?? "").trim().toLowerCase();
  if (text.length === 0) {
    return "UNSPECIFIED";
  }
  if (text.startsWith("self")) {
    return "SELF";
  }
  if (text.startsWith("spouse")) {
    return "SPOUSE";
  }
  if (text.startsWith("joint")) {
    return "JOINT";
  }
  if (text.startsWith("child")) {
    return "CHILD";
  }
  if (text.startsWith("dependent")) {
    return "DEPENDENT";
  }
  return "OTHER";
}

export const CONGRESS_ASSET_CLASSES = [
  "STOCK",
  "STOCK_OPTION",
  "BOND",
  "FUND",
  "CRYPTO",
  "OTHER",
] as const;

export type CongressAssetClass = (typeof CONGRESS_ASSET_CLASSES)[number];

/**
 * Normalizes the disclosed asset type.
 *
 * Only `STOCK` maps safely onto this product's `Security` model, which is why the classification
 * exists at all: a corporate bond or an option on the same ticker is a different instrument, and
 * counting it as a share purchase would misstate what the member did. Everything else is preserved
 * and simply not counted by a V1 metric — see {@link isCongressTradeStrategyEligible}.
 */
export function classifyCongressAssetClass(
  providerAssetType: string | undefined,
): CongressAssetClass {
  const text = (providerAssetType ?? "").trim().toLowerCase();
  if (text.length === 0) {
    return "OTHER";
  }
  if (text.includes("option") || text.includes("warrant")) {
    return "STOCK_OPTION";
  }
  if (text.includes("bond") || text.includes("note") || text.includes("bill")) {
    return "BOND";
  }
  if (
    text.includes("fund") ||
    text.includes("etf") ||
    text.includes("etp") ||
    text.includes("trust")
  ) {
    return "FUND";
  }
  if (text.includes("crypto") || text.includes("digital asset")) {
    return "CRYPTO";
  }
  if (text.includes("stock") || text.includes("equity")) {
    return "STOCK";
  }
  return "OTHER";
}

/**
 * Whether a normalized disclosure may feed a V1 strategy metric.
 *
 * Exactly the rows whose asset is common stock. Bonds, options, funds and crypto are ingested,
 * preserved and visible, but no metric counts them: `docs/alternative-data-signals.md` scopes V1 to
 * the security types that map safely onto the stock model.
 */
export function isCongressTradeStrategyEligible(trade: {
  assetClass: CongressAssetClass;
}): boolean {
  return trade.assetClass === "STOCK";
}

/**
 * A disclosed amount, as a range.
 *
 * `upperBound` is absent on an open-ended top band ("Over $50,000,000"). No midpoint is stored or
 * computed: the filing discloses a band, and a single number would be a fabrication.
 */
export type DisclosedAmountRange = {
  /** The provider's own text, preserved. */
  raw: string;
  lowerBound?: number;
  upperBound?: number;
};

/**
 * Parses a disclosed amount band.
 *
 * Handles the forms the filings actually use: `"$1,001 - $15,000"`, `"$1,001-$15,000"`,
 * `"Over $50,000,000"`, `"$50,000,001 +"` and a bare `"$15,000"`. A string with no number at all
 * yields bounds of `undefined` rather than zero, so an unparsed band can never read as a $0 trade.
 */
export function parseDisclosedAmountRange(
  raw: string | undefined,
): DisclosedAmountRange {
  const text = (raw ?? "").trim();
  const numbers = [...text.matchAll(/\$?\s*([\d][\d,]*(?:\.\d+)?)/g)]
    .map((match) => Number((match[1] ?? "").replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return { raw: text };
  }
  const [first, second] = numbers;
  const openEnded =
    /over|more than|\+|and\s+(?:over|above)|or\s+more/i.test(text) ||
    numbers.length === 1;
  if (openEnded) {
    return { raw: text, lowerBound: first as number };
  }
  const lower = Math.min(first as number, second as number);
  const upper = Math.max(first as number, second as number);
  return { raw: text, lowerBound: lower, upperBound: upper };
}

/** One normalized congressional disclosure, as it is persisted and evaluated. */
export type CongressTradeFact = {
  securityId: SecurityId;
  actorExternalId: string;
  actorDisplayName: string;
  chamber: CongressChamber;
  transactionDate: LocalDate;
  disclosureDate: LocalDate;
  availableFromDate: LocalDate;
  kind: CongressTransactionKind;
  /** The provider's own `type`, unchanged. */
  typeRaw: string;
  owner: CongressOwner;
  ownerRaw?: string;
  assetClass: CongressAssetClass;
  assetTypeRaw?: string;
  assetDescription?: string;
  amount: DisclosedAmountRange;
  capitalGainsOver200Usd?: boolean;
  comment?: string;
  sourceUrl?: string;
};
