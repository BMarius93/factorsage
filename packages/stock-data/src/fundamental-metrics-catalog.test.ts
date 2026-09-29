import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS as PRODUCT_FUNDAMENTAL_METRIC_IDS,
  type FundamentalMetricId as ProductFundamentalMetricId,
  type FundamentalMetricUnit as ProductFundamentalMetricUnit,
} from "@intrinsic/contracts";
import {
  FUNDAMENTAL_METRICS,
  FUNDAMENTAL_METRIC_IDS as DOMAIN_FUNDAMENTAL_METRIC_IDS,
  type FundamentalMetricId as DomainFundamentalMetricId,
  type FundamentalMetricUnit as DomainFundamentalMetricUnit,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";

/**
 * Drift guard between the Fundamental Metrics product catalog and the registry of what is
 * materialized.
 *
 * `@intrinsic/contracts` owns the product catalog — label, group, order, threshold floor — because it
 * is the only package the web app may depend on, and it cannot import `@intrinsic/domain`.
 * `@intrinsic/domain` owns identity, storage field and unit. This suite lives here, the lowest package
 * allowed to depend on both, and fails the moment one side gains, loses, renames, reorders or
 * re-units a metric without the other: a metric the Builder offers but nothing materializes would
 * read as permanently unavailable, and one materialized but never offered would be unreachable.
 */

/** Compile-time half of the guard: the two identity and unit vocabularies are the same set. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const IDENTITIES_MATCH: Same<
  ProductFundamentalMetricId,
  DomainFundamentalMetricId
> = true;
const UNITS_MATCH: Same<
  ProductFundamentalMetricUnit,
  DomainFundamentalMetricUnit
> = true;

describe("the Fundamental Metrics product catalog and the domain registry", () => {
  it("agree at compile time on every identity and unit", () => {
    expect(IDENTITIES_MATCH).toBe(true);
    expect(UNITS_MATCH).toBe(true);
  });

  it("name exactly the same fifteen identities, in the same order", () => {
    expect(PRODUCT_FUNDAMENTAL_METRIC_IDS).toHaveLength(15);
    expect(DOMAIN_FUNDAMENTAL_METRIC_IDS).toHaveLength(15);
    expect(new Set(PRODUCT_FUNDAMENTAL_METRIC_IDS).size).toBe(15);
    expect([...PRODUCT_FUNDAMENTAL_METRIC_IDS]).toEqual([
      ...DOMAIN_FUNDAMENTAL_METRIC_IDS,
    ]);
  });

  it("express every metric in the unit the domain stores it in", () => {
    const domainUnit = new Map<string, string>(
      FUNDAMENTAL_METRICS.map((metric) => [metric.id, metric.unit]),
    );
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(entry.unit, entry.id).toBe(domainUnit.get(entry.id));
    }
    // Stated per unit as well, so a swapped pair cannot hide behind equal counts.
    const idsIn = (
      unit: string,
      entries: readonly { id: string; unit: string }[],
    ) =>
      entries.filter((entry) => entry.unit === unit).map((entry) => entry.id);
    for (const unit of ["PERCENT", "MULTIPLE"]) {
      expect(idsIn(unit, FUNDAMENTAL_METRIC_CATALOG), unit).toEqual(
        idsIn(unit, FUNDAMENTAL_METRICS),
      );
    }
  });

  it("keep the product vocabulary free of storage fields", () => {
    // The catalog carries no field and derives none: the field is read from the domain registry
    // where a value is projected, and nowhere else.
    const fields = new Set<string>(
      FUNDAMENTAL_METRICS.map((metric) => metric.field),
    );
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      expect(Object.keys(entry)).not.toContain("field");
      for (const text of [
        entry.id,
        entry.label,
        entry.summary,
        entry.formula,
      ]) {
        for (const field of fields) {
          expect(text, `${entry.id} names ${field}`).not.toContain(field);
        }
      }
    }
  });
});
