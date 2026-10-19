import type { LocalDate, MarketIndexKey } from "@intrinsic/domain";
import { addDays } from "../dates.js";
import type { StoredIndexConstituent } from "./ports.js";
import type { ConstituentOrigin } from "./reconstruction.js";
import type { MembershipWindow } from "./resolution.js";

/**
 * Identity corrections: constituents whose history the provider holds under a symbol that the
 * generic resolution (`resolution.ts`) cannot reach, or reaches with the wrong dates
 * (`docs/decisions/sp500-historical-pit-v1.md` §4.1).
 *
 * Each one is an explicit, reviewed decision about **one** constituent, with its evidence. None is a
 * rule: nothing here links two companies because they share a successor ticker or a corporate
 * lineage, and nothing substitutes one share class for another. A correction names the only
 * candidate symbol the constituent is probed against, so the same measured checks still decide it
 * — prices inside the membership, a plausible market capitalization or trading value, and the
 * one-security-one-constituent-at-a-time rule — and a correction the provider's data does not bear
 * out is refused like any other candidate.
 *
 * A correction matches a constituent on its ticker, name, origin and the change log's own dates of
 * its addition and removal, all at once, and only when exactly one constituent matches: a
 * reconstruction that no longer produces that constituent leaves the correction unmatched — reported,
 * never applied elsewhere.
 */
export type IndexIdentityCorrection = {
  /** Stable: recorded in the resolution evidence, so a changed correction is re-probed. */
  readonly id: string;
  readonly indexKey: MarketIndexKey;
  readonly match: {
    readonly ticker: string;
    readonly name: string;
    readonly origin: ConstituentOrigin;
    /** The change log's date of the addition (`startLogDate` or `startDate`); null before the log. */
    readonly addedOn: LocalDate | null;
    /** The change log's date of the removal; null for a current member. */
    readonly removedOn: LocalDate | null;
  };
  /** The provider symbol whose history is this constituent's: the only candidate it is probed against. */
  readonly symbol: string;
  /**
   * The first day the symbol's prices are this constituent's history, when they begin as another
   * issuer's: the membership before it stays in the index, unpriced, and is never given those prices.
   */
  readonly securityFrom?: LocalDate;
  readonly evidence: string;
};

export const INDEX_IDENTITY_CORRECTIONS: readonly IndexIdentityCorrection[] = [
  {
    id: "SP500:cablevision-1:CVC",
    indexKey: "SP500",
    match: {
      ticker: "RMG",
      name: "Cablevision Systems Corp.",
      origin: "REMOVAL",
      addedOn: "2010-12-17",
      removedOn: "2016-06-23",
    },
    symbol: "CVC",
    evidence:
      "The provider's change log labels Cablevision Systems (added 2010-12-17 for King Pharmaceuticals, " +
      "removed 2016-06-23 for Fortune Brands Home & Security, after Altice acquired it) with RMG — a " +
      "ticker RiskMetrics held until 2010 and Romeo Power from 2020, neither of which is Cablevision. " +
      "Cablevision traded as CVC on the NYSE throughout its membership, and the provider's CVC history " +
      "(2010-12-20 to 2016-06-20) covers it. RMG and its renames are never probed for it.",
  },
  {
    id: "SP500:dun-bradstreet-1979:MCO",
    indexKey: "SP500",
    match: {
      ticker: "DNB",
      name: "Dun & Bradstreet Corp",
      origin: "REMOVAL",
      addedOn: "1979-12-27",
      removedOn: "2000-10-02",
    },
    symbol: "MCO",
    evidence:
      "The Dun & Bradstreet Corporation that was a member until 2000-10-02 is the legal entity that, on " +
      "2000-09-30, spun off a new Dun & Bradstreet and renamed itself Moody's Corporation; the index " +
      "replaced its DNB line with MCO on 2000-10-02. The provider carries that entity's pre-2000 " +
      "history under MCO, continuous through the spin-off. The later Dun & Bradstreet constituent " +
      "(2008-12-02 to 2017-04-04) is the spun-off company, has no history under MCO, and is not matched.",
  },
  {
    id: "SP500:dean-witter-discover-1993:MS",
    indexKey: "SP500",
    match: {
      ticker: "DWD",
      name: "Dean Witter Discover & Co.",
      origin: "REMOVAL",
      addedOn: "1993-07-12",
      removedOn: "1997-05-30",
    },
    symbol: "MS",
    evidence:
      "Dean Witter, Discover & Co. acquired Morgan Stanley Group on 1997-05-31 and, as the legal " +
      "survivor, became Morgan Stanley, Dean Witter, Discover & Co. (MWD, later MS). The provider's " +
      "MS history begins at Dean Witter Discover's own listing (1993-02-23) and runs unbroken through " +
      "the merger (17.64 on 1997-05-30, 17.74 at the next open, no exchange-ratio jump): it is Dean " +
      "Witter Discover's. The index removed the DWD line at the merger (log 1997-05-30).",
  },
  {
    id: "SP500:morgan-stanley-1995:MS-from-1997-06-02",
    indexKey: "SP500",
    match: {
      ticker: "MS",
      name: "Morgan Stanley",
      origin: "CURRENT",
      addedOn: "1995-09-21",
      removedOn: null,
    },
    symbol: "MS",
    securityFrom: "1997-06-02",
    evidence:
      "This constituent was Morgan Stanley Group Inc. from its addition (1995-09-21) until it merged " +
      "into Dean Witter Discover on 1997-05-31. The provider's MS prices before the merged company's " +
      "first session (1997-06-02) are Dean Witter Discover's (its 1993 listing), not Morgan Stanley " +
      "Group's, which the provider does not hold; they are this constituent's history only from " +
      "1997-06-02. Its earlier membership stays in the index, unpriced.",
  },
];

/** The change log's own dates of a constituent's first addition and last removal. */
export function membershipLogDates(
  constituent: Pick<StoredIndexConstituent, "periods">,
): { addedOn: LocalDate | null; removedOn: LocalDate | null } {
  const first = constituent.periods[0];
  const last = constituent.periods.at(-1);
  return {
    addedOn: first ? (first.startLogDate ?? first.startDate) : null,
    removedOn:
      last && last.endDate !== null
        ? addDays(last.endLogDate ?? last.endDate, 1)
        : null,
  };
}

export type CorrectionMatch = {
  /** Constituent key → the correction that applies to it. */
  readonly applied: ReadonlyMap<string, IndexIdentityCorrection>;
  /** Corrections that matched no constituent, or more than one: never applied. */
  readonly unmatched: readonly { id: string; matches: number }[];
};

/** Which corrections apply to which of `constituents`, each to exactly one or to none. */
export function matchIdentityCorrections(
  indexKey: MarketIndexKey,
  constituents: readonly Pick<
    StoredIndexConstituent,
    "constituentKey" | "ticker" | "name" | "origin" | "periods"
  >[],
  corrections: readonly IndexIdentityCorrection[] = INDEX_IDENTITY_CORRECTIONS,
): CorrectionMatch {
  const applied = new Map<string, IndexIdentityCorrection>();
  const unmatched: { id: string; matches: number }[] = [];
  for (const correction of corrections) {
    if (correction.indexKey !== indexKey) {
      continue;
    }
    const matches = constituents.filter((constituent) => {
      const dates = membershipLogDates(constituent);
      return (
        constituent.ticker === correction.match.ticker &&
        constituent.name === correction.match.name &&
        constituent.origin === correction.match.origin &&
        dates.addedOn === correction.match.addedOn &&
        dates.removedOn === correction.match.removedOn
      );
    });
    if (matches.length === 1 && !applied.has(matches[0]!.constituentKey)) {
      applied.set(matches[0]!.constituentKey, correction);
    } else {
      unmatched.push({ id: correction.id, matches: matches.length });
    }
  }
  return { applied, unmatched };
}

/** Membership windows from the first day the security's prices are the constituent's history. */
export function windowsFrom(
  windows: readonly MembershipWindow[],
  securityFrom: LocalDate | null | undefined,
): MembershipWindow[] {
  if (!securityFrom) {
    return [...windows];
  }
  return windows
    .filter((window) => window.to >= securityFrom)
    .map((window) =>
      window.from < securityFrom
        ? { from: securityFrom, to: window.to }
        : window,
    );
}

/** The correction a stored resolution was decided under, if any. */
export function storedCorrectionId(
  constituent: Pick<StoredIndexConstituent, "resolutionEvidence">,
): string | null {
  const evidence = constituent.resolutionEvidence as {
    correction?: { id?: unknown };
    probe?: { correction?: { id?: unknown } };
  } | null;
  const id = evidence?.correction?.id ?? evidence?.probe?.correction?.id;
  return typeof id === "string" ? id : null;
}
