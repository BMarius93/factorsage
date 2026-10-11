/**
 * The fictional members of Congress the E2E suites select.
 *
 * The hermetic E2E stack reaches no provider, so it ingests no disclosure and its actor catalog would
 * otherwise be empty — and a rule can only select a member the catalog holds. `pnpm
 * test:securities:seed` writes exactly these rows into the **test** database, and a spec names them
 * from here, so the seeder and the browser cannot disagree about who exists.
 *
 * Every name and identifier is invented. The identifiers are deliberately not bioguide-shaped: a
 * real one is a letter and six digits, and nothing here may ever be mistaken for — or collide with
 * — a real member's.
 *
 * `ALIAS` carries the provider's formal spelling of somebody people search for by another name, the
 * way the real catalog holds "Rafael E Cruz" for Ted Cruz. It is what lets a spec prove that a
 * search for the familiar name still finds the member.
 */
export const QA_CONGRESS_MEMBERS = {
  HOUSE: {
    externalId: "QA-E2E-MEMBER-HOUSE",
    displayName: "Quentin Aldersgate",
    chamber: "HOUSE",
    state: "CA",
    district: "CA12",
    meta: "House · CA12",
  },
  SENATE: {
    externalId: "QA-E2E-MEMBER-SENATE",
    displayName: "Rosalind Fairweather",
    chamber: "SENATE",
    state: "TX",
    district: undefined,
    meta: "Senate · TX",
  },
  ALIAS: {
    externalId: "QA-E2E-MEMBER-ALIAS",
    displayName: "Bartholomew J Winterbourne",
    chamber: "SENATE",
    state: "AL",
    district: undefined,
    meta: "Senate · AL",
    /** What a person would type; the catalog does not hold it. */
    familiarName: "Barty Winterbourne",
  },
} as const;

export type QaCongressMember =
  (typeof QA_CONGRESS_MEMBERS)[keyof typeof QA_CONGRESS_MEMBERS];

/** Every fixture member, in a stable order. */
export const QA_CONGRESS_MEMBER_LIST: readonly QaCongressMember[] =
  Object.values(QA_CONGRESS_MEMBERS);
