import { createHash } from "node:crypto";
import {
  normalizeBuyWindowConfiguration,
  type BuyWindowMode,
} from "@intrinsic/domain";

/**
 * The origin a customer's Strategy or List is recorded with when it is created
 * (`docs/decisions/canonical-definitions-v1.md` §5) — the smallest record that lets a later reader
 * tell **custom** content from a **derived** copy of a built-in, and an unchanged copy from an
 * edited one, without ever matching on a name.
 *
 * `AUTHORED` content was written from scratch. A `COPIED` row carries the built-in at the root of
 * its copy chain — the source itself, when the source is SYSTEM content, or whatever built-in the
 * source was itself copied from — together with what that built-in was at the moment of the first
 * copy. A copy of content whose origin was never recorded records nothing, so it stays *not
 * recorded* rather than being guessed into either answer.
 */

type ContentOwnershipValue = "USER" | "SYSTEM";
type ContentOriginValue = "AUTHORED" | "COPIED";

export type StrategyOriginColumns = {
  origin: ContentOriginValue | null;
  originSystemKey: string | null;
  originVersionNumber: number | null;
  originDefinitionHash: string | null;
};

export type ListOriginColumns = {
  origin: ContentOriginValue | null;
  originSystemKey: string | null;
  originMembershipDigest: string | null;
};

export const AUTHORED_STRATEGY_ORIGIN: StrategyOriginColumns = {
  origin: "AUTHORED",
  originSystemKey: null,
  originVersionNumber: null,
  originDefinitionHash: null,
};

export const AUTHORED_LIST_ORIGIN: ListOriginColumns = {
  origin: "AUTHORED",
  originSystemKey: null,
  originMembershipDigest: null,
};

/** The origin of a copy of `source`, whose current version is `sourceVersion`. */
export function copiedStrategyOrigin(
  source: StrategyOriginColumns & {
    ownership: ContentOwnershipValue;
    systemKey: string | null;
  },
  sourceVersion: { versionNumber: number; definitionHash: string },
): StrategyOriginColumns {
  if (source.ownership === "SYSTEM" && source.systemKey) {
    return {
      origin: "COPIED",
      originSystemKey: source.systemKey,
      originVersionNumber: sourceVersion.versionNumber,
      originDefinitionHash: sourceVersion.definitionHash,
    };
  }
  if (source.origin === null) {
    return {
      origin: null,
      originSystemKey: null,
      originVersionNumber: null,
      originDefinitionHash: null,
    };
  }
  return {
    origin: "COPIED",
    originSystemKey: source.originSystemKey,
    originVersionNumber: source.originVersionNumber,
    originDefinitionHash: source.originDefinitionHash,
  };
}

/** The origin of a copy of `source`, whose members fingerprint to `sourceMembershipDigest`. */
export function copiedListOrigin(
  source: ListOriginColumns & {
    ownership: ContentOwnershipValue;
    systemKey: string | null;
  },
  sourceMembershipDigest: string,
): ListOriginColumns {
  if (source.ownership === "SYSTEM" && source.systemKey) {
    return {
      origin: "COPIED",
      originSystemKey: source.systemKey,
      originMembershipDigest: sourceMembershipDigest,
    };
  }
  if (source.origin === null) {
    return {
      origin: null,
      originSystemKey: null,
      originMembershipDigest: null,
    };
  }
  return {
    origin: "COPIED",
    originSystemKey: source.originSystemKey,
    originMembershipDigest: source.originMembershipDigest,
  };
}

export type FingerprintedListMember = {
  securityId: string;
  buyWindowMode: BuyWindowMode;
  buyWindows: readonly { startDate: string; endDate: string | null }[];
};

/**
 * One digest for a List's membership in this database: every member by security id with its
 * canonical buy window, sorted by security id.
 *
 * Environment-local on purpose — it compares a copy's membership with its source's in the same
 * database, where the security id is the identity a symbol rename cannot move — and computed the
 * same way over a List's rows and over a backtest snapshot's frozen securities, so "this run's
 * List is the built-in exactly as it was copied" is one string comparison.
 */
export function listMembershipFingerprint(
  members: readonly FingerprintedListMember[],
): string {
  const canonical = members
    .map((member) => {
      const window = normalizeBuyWindowConfiguration({
        mode: member.buyWindowMode,
        ranges: member.buyWindows,
      });
      return [
        member.securityId,
        window.mode,
        window.ranges.map((range) => [range.startDate, range.endDate]),
      ] as const;
    })
    .sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
  return createHash("sha256")
    .update(JSON.stringify(["list-membership", 1, canonical]))
    .digest("hex");
}
