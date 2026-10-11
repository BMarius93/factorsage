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
 *
 * `HOUSE` carries a second spelling, the way the real catalog holds the member directory's "Bill
 * Cassidy" beside a disclosure's "William Cassidy". `directoryFirstName` is a word only that second
 * spelling holds, so a search for it can only succeed through the directory's spelling.
 *
 * The seeder also records the catalog as synchronized, which is the state a deployment's catalog is
 * in once `pnpm data:congress-members:sync` has run: the hermetic stack reaches no provider, so the
 * seed is its synchronization.
 */
export const QA_CONGRESS_MEMBERS = {
  HOUSE: {
    externalId: "QA-E2E-MEMBER-HOUSE",
    displayName: "Quentin Aldersgate",
    /** The member directory's spelling, stored beside the label. */
    directoryName: "Quint Aldersgate",
    /** What only the directory's spelling holds. */
    directoryFirstName: "Quint",
    chamber: "HOUSE",
    state: "CA",
    district: "CA12",
    meta: "House · CA12",
  },
  SENATE: {
    externalId: "QA-E2E-MEMBER-SENATE",
    displayName: "Rosalind Fairweather",
    directoryName: undefined,
    chamber: "SENATE",
    state: "TX",
    district: undefined,
    meta: "Senate · TX",
  },
  ALIAS: {
    externalId: "QA-E2E-MEMBER-ALIAS",
    displayName: "Bartholomew J Winterbourne",
    directoryName: undefined,
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
