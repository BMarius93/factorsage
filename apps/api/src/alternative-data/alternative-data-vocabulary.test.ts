import {
  CONGRESS_CHAMBERS,
  CONGRESS_OWNERS,
  INSIDER_ROLES,
  SELECTABLE_CONGRESS_OWNERS,
  SELECTABLE_INSIDER_ROLES,
} from "@intrinsic/contracts";
import {
  CongressAssetClass,
  CongressChamber,
  CongressOwner,
  CongressTransactionKind,
  InsiderRole,
  InsiderTransactionCategory,
} from "@intrinsic/database";
import {
  CONGRESS_ASSET_CLASSES,
  CONGRESS_CHAMBERS as DOMAIN_CHAMBERS,
  CONGRESS_OWNERS as DOMAIN_OWNERS,
  CONGRESS_TRANSACTION_KINDS,
  INSIDER_ROLES as DOMAIN_INSIDER_ROLES,
  INSIDER_TRANSACTION_CATEGORIES,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the alternative-data vocabulary.
 *
 * The same enums are declared three times on purpose, and each declaration exists for a reason:
 *
 * - `@intrinsic/contracts` is the only package the web app may depend on, so the browser-facing
 *   vocabulary lives there. It has no dependency on `@intrinsic/domain` — `BuyWindowMode` is declared
 *   twice for exactly the same reason.
 * - `@intrinsic/domain` owns the *normalization* of provider facts into these values.
 * - `@intrinsic/database` owns the persisted PostgreSQL enums.
 *
 * Nothing stops those three drifting except this suite, which lives in the API — the closest package
 * that depends on all of them — and fails the moment one side gains, loses, renames or reorders a
 * value. It is the same pattern as `../stocks/selectable-series-catalog.test.ts`.
 *
 * Entirely offline: it compares constants and constructs nothing.
 */
describe("alternative-data vocabulary", () => {
  it("declares one chamber vocabulary in all three packages", () => {
    expect([...CONGRESS_CHAMBERS]).toEqual([...DOMAIN_CHAMBERS]);
    expect([...CONGRESS_CHAMBERS]).toEqual(Object.values(CongressChamber));
  });

  it("declares one insider-role vocabulary in all three packages", () => {
    expect([...INSIDER_ROLES]).toEqual([...DOMAIN_INSIDER_ROLES]);
    expect([...INSIDER_ROLES]).toEqual(Object.values(InsiderRole));
  });

  it("declares one congressional-owner vocabulary in all three packages", () => {
    expect([...CONGRESS_OWNERS]).toEqual([...DOMAIN_OWNERS]);
    expect([...CONGRESS_OWNERS]).toEqual(Object.values(CongressOwner));
  });

  it("keeps the insider categories and congressional kinds the database can store", () => {
    // These have no contracts-side declaration: a strategy never names a transaction category or a
    // transaction kind directly — a *measure* selects them — so only the domain and the schema need to
    // agree, and this is what makes that true.
    expect([...INSIDER_TRANSACTION_CATEGORIES]).toEqual(
      Object.values(InsiderTransactionCategory),
    );
    expect([...CONGRESS_TRANSACTION_KINDS]).toEqual(
      Object.values(CongressTransactionKind),
    );
    expect([...CONGRESS_ASSET_CLASSES]).toEqual(
      Object.values(CongressAssetClass),
    );
  });

  it("offers as filters only the values that state something", () => {
    // `OTHER` and `UNSPECIFIED` are the buckets for a provider string that states nothing
    // recognizable. They are persisted, readable and counted by an unfiltered metric — and never
    // offered as a filter choice, because selecting "we could not tell" is not a rule anybody means.
    expect([...SELECTABLE_INSIDER_ROLES]).toEqual(
      INSIDER_ROLES.filter((role) => role !== "OTHER"),
    );
    expect([...SELECTABLE_CONGRESS_OWNERS]).toEqual(
      CONGRESS_OWNERS.filter((owner) => owner !== "UNSPECIFIED"),
    );
  });

  it("has no institutional vocabulary at all", async () => {
    // V1 ships Insider Activity and Congressional Trading. Form 13F is absent from every layer —
    // there is no enum, no table and no measure to drift against — because the provider subscription
    // does not expose it (`docs/alternative-data-signals.md`). Asserted on the module namespaces
    // rather than on a grep, so a reintroduced symbol fails a test instead of passing review.
    const surfaces = await Promise.all([
      import("@intrinsic/database"),
      import("@intrinsic/domain"),
      import("@intrinsic/contracts"),
    ]);
    for (const surface of surfaces) {
      expect(
        Object.keys(surface).filter((name) => /institutional/i.test(name)),
      ).toEqual([]);
    }
  });
});
