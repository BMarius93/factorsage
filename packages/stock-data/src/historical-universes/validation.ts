import type { LocalDate } from "@intrinsic/domain";
import type { MetricUnavailability } from "./metrics.js";

/**
 * When a generated universe may be published (`docs/decisions/historical-universes-v1.md` §6).
 *
 * A ranking over the members that happen to have data is not a ranking over the index: where the
 * provider holds no prices for a large share of former members, "the top 100" is the top 100 of the
 * survivors. So each reconstitution is measured, and a universe is published only from the first
 * reconstitution after which **every** reconstitution passes:
 *
 * - **Data coverage** — members with market data on the date, over the parent index's lines
 *   (unresolved constituents and members without a price that day count against it) — at least
 *   {@link MIN_DATA_COVERAGE}. Missing data is the provider's gap, not the member's ineligibility.
 * - **Metric availability** — members with a value, over members with market data — at least
 *   {@link MIN_METRIC_AVAILABILITY}: a ranking that cannot read most members' value is not one. A
 *   member that is genuinely ineligible (too short a history, no dividend) lowers it too, which is
 *   why it is held to a lower bar than coverage.
 * - **Full selection** — as many selected as the rule asks for.
 * - **A reliable parent** — for a universe drawn from another universe, that universe is reliable on
 *   the date (on or after its own `reliableFrom`).
 *
 * Two further conditions: the reliable span is at least {@link MIN_RELIABLE_YEARS} long, and the
 * newest reconstitution is no older than {@link MAX_STALENESS_DAYS} before the newest session the
 * data has, so a published universe is current. Anything else stays `DRAFT` with the reasons.
 */

export const MIN_DATA_COVERAGE = 0.9;
/**
 * A retrospectively classified universe's one publication gate of its own: the share of the index's
 * catalog securities the provider classifies. Below it a sector grouping would leave out too many
 * members silently, so it stays `DRAFT`.
 */
export const MIN_CLASSIFIED_SHARE = 0.95;
export const MIN_METRIC_AVAILABILITY = 0.75;
export const MIN_RELIABLE_YEARS = 5;
export const MAX_STALENESS_DAYS = 400;

export type ReconstitutionDiagnostic = {
  readonly date: LocalDate;
  readonly effectiveDate: LocalDate;
  /** The parent's lines on the date: index constituents, or a parent universe's selection. */
  readonly parentLines: number;
  /** Parent lines tied to a catalog security. */
  readonly parentMembers: number;
  /** Members with market data on the date (a close; for dividend metrics, synchronized dividends). */
  readonly withData: number;
  /** Members with a usable value. */
  readonly withValue: number;
  readonly expected: number;
  readonly selected: number;
  /** Why members had no value, by reason. */
  readonly unavailable: Readonly<Partial<Record<MetricUnavailability, number>>>;
  /**
   * For a universe drawn from another universe's selection: whether that selection is reliable on
   * the date. A ranking of an unreliable selection is not reliable however complete its own data is.
   */
  readonly parentReliable?: boolean;
  /** For a retrospectively classified universe: how the index's members on the date classified. */
  readonly classification?: ClassificationDiagnostic;
};

export type ClassificationDiagnostic = {
  /** Index members (catalog securities) the provider classifies. */
  readonly classified: number;
  /** Index members with no sector, or one outside the eleven. */
  readonly unclassified: number;
  /** Index members whose sector is in the universe's group. */
  readonly groupMembers: number;
  /** Group members with a stored close on the date. */
  readonly groupPriced: number;
};

export type ValidationReason =
  | { readonly code: "NO_RECONSTITUTIONS" }
  | { readonly code: "NO_RELIABLE_PERIOD"; readonly detail: string }
  | {
      readonly code: "RELIABLE_PERIOD_TOO_SHORT";
      readonly reliableFrom: LocalDate;
      readonly years: number;
    }
  | {
      readonly code: "STALE";
      readonly lastReconstitution: LocalDate;
      readonly latestSession: LocalDate;
    }
  | {
      readonly code: "CLASSIFICATION_INCOMPLETE";
      readonly classifiedShare: number;
      readonly minimum: number;
    }
  | { readonly code: "EMPTY_CLASSIFICATION_GROUP"; readonly date: LocalDate };

/**
 * What a published universe discloses rather than gates on. A retrospectively classified universe
 * carries all four; no other universe carries any.
 */
export type ValidationWarning =
  | { readonly code: "RETROSPECTIVE_CLASSIFICATION"; readonly detail: string }
  | {
      readonly code: "UNCLASSIFIED_MEMBERS";
      /** Unclassified index securities, of `indexSecurities` over the index's history. */
      readonly securities: number;
      readonly indexSecurities: number;
      readonly detail: string;
    }
  | {
      readonly code: "INCOMPLETE_PRICE_COVERAGE";
      /** The first checkpoint from which every one has a price for 90 % of the group; null: none. */
      readonly coveredFrom: LocalDate | null;
      readonly detail: string;
    }
  | { readonly code: "SURVIVORSHIP_BIAS"; readonly detail: string };

export type GenerationValidation = {
  readonly verdict: "VALIDATED" | "DRAFT";
  /** The first reconstitution from which every one passes; null when none does. */
  readonly reliableFrom: LocalDate | null;
  /** The first day the List carries: the effective date of `reliableFrom`. */
  readonly publishFrom: LocalDate | null;
  readonly reasons: readonly ValidationReason[];
  readonly criteria: {
    readonly minDataCoverage: number;
    readonly minMetricAvailability: number;
    readonly minReliableYears: number;
    readonly maxStalenessDays: number;
  };
  /** Disclosures that do not gate publication. */
  readonly warnings?: readonly ValidationWarning[];
  /** Per calendar year: the lowest data coverage and metric availability, and failed dates. */
  readonly byYear: readonly {
    readonly year: string;
    readonly reconstitutions: number;
    readonly minDataCoverage: number | null;
    readonly minMetricAvailability: number | null;
    readonly failing: number;
  }[];
};

export function reconstitutionPasses(
  diagnostic: ReconstitutionDiagnostic,
  criteria = {
    minDataCoverage: MIN_DATA_COVERAGE,
    minMetricAvailability: MIN_METRIC_AVAILABILITY,
  },
): boolean {
  if (
    diagnostic.parentLines <= 0 ||
    diagnostic.expected <= 0 ||
    diagnostic.parentReliable === false
  ) {
    return false;
  }
  const coverage = diagnostic.withData / diagnostic.parentLines;
  const availability =
    diagnostic.withData === 0 ? 0 : diagnostic.withValue / diagnostic.withData;
  return (
    coverage >= criteria.minDataCoverage &&
    availability >= criteria.minMetricAvailability &&
    diagnostic.selected === diagnostic.expected
  );
}

const yearsBetween = (from: LocalDate, to: LocalDate) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  (365.25 * 86_400_000);

export function validateGeneration(input: {
  readonly diagnostics: readonly ReconstitutionDiagnostic[];
  readonly latestSession: LocalDate | null;
  readonly criteria?: Partial<GenerationValidation["criteria"]>;
}): GenerationValidation {
  const criteria = {
    minDataCoverage: input.criteria?.minDataCoverage ?? MIN_DATA_COVERAGE,
    minMetricAvailability:
      input.criteria?.minMetricAvailability ?? MIN_METRIC_AVAILABILITY,
    minReliableYears: input.criteria?.minReliableYears ?? MIN_RELIABLE_YEARS,
    maxStalenessDays: input.criteria?.maxStalenessDays ?? MAX_STALENESS_DAYS,
  };
  const ordered = [...input.diagnostics].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  const byYear = new Map<
    string,
    {
      reconstitutions: number;
      minCoverage: number | null;
      minAvailability: number | null;
      failing: number;
    }
  >();
  for (const diagnostic of ordered) {
    const year = diagnostic.date.slice(0, 4);
    const entry = byYear.get(year) ?? {
      reconstitutions: 0,
      minCoverage: null,
      minAvailability: null,
      failing: 0,
    };
    const coverage =
      diagnostic.parentLines > 0
        ? diagnostic.withData / diagnostic.parentLines
        : 0;
    const availability =
      diagnostic.withData > 0 ? diagnostic.withValue / diagnostic.withData : 0;
    entry.reconstitutions += 1;
    entry.minCoverage =
      entry.minCoverage === null
        ? coverage
        : Math.min(entry.minCoverage, coverage);
    entry.minAvailability =
      entry.minAvailability === null
        ? availability
        : Math.min(entry.minAvailability, availability);
    if (!reconstitutionPasses(diagnostic, criteria)) {
      entry.failing += 1;
    }
    byYear.set(year, entry);
  }
  const summary = [...byYear.entries()].map(([year, entry]) => ({
    year,
    reconstitutions: entry.reconstitutions,
    minDataCoverage: entry.minCoverage,
    minMetricAvailability: entry.minAvailability,
    failing: entry.failing,
  }));
  if (ordered.length === 0) {
    return {
      verdict: "DRAFT",
      reliableFrom: null,
      publishFrom: null,
      reasons: [{ code: "NO_RECONSTITUTIONS" }],
      criteria,
      byYear: summary,
    };
  }
  // The reliable period is a suffix: the reconstitutions after the last one that fails.
  let firstReliable = ordered.length;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (
      !reconstitutionPasses(
        ordered[index] as ReconstitutionDiagnostic,
        criteria,
      )
    ) {
      break;
    }
    firstReliable = index;
  }
  const reasons: ValidationReason[] = [];
  const last = ordered[ordered.length - 1] as ReconstitutionDiagnostic;
  if (firstReliable === ordered.length) {
    const failing = last;
    reasons.push({
      code: "NO_RELIABLE_PERIOD",
      detail: `the latest reconstitution (${failing.date}) fails: data coverage ${(failing.parentLines > 0 ? failing.withData / failing.parentLines : 0).toFixed(3)}, ${failing.withValue} with a value of ${failing.withData} with data, ${failing.selected} of ${failing.expected} selected`,
    });
    return {
      verdict: "DRAFT",
      reliableFrom: null,
      publishFrom: null,
      reasons,
      criteria,
      byYear: summary,
    };
  }
  const reliable = ordered[firstReliable] as ReconstitutionDiagnostic;
  const years = yearsBetween(reliable.date, last.date);
  if (years < criteria.minReliableYears) {
    reasons.push({
      code: "RELIABLE_PERIOD_TOO_SHORT",
      reliableFrom: reliable.date,
      years: Math.round(years * 10) / 10,
    });
  }
  if (
    input.latestSession !== null &&
    yearsBetween(last.date, input.latestSession) * 365.25 >
      criteria.maxStalenessDays
  ) {
    reasons.push({
      code: "STALE",
      lastReconstitution: last.date,
      latestSession: input.latestSession,
    });
  }
  return {
    verdict: reasons.length === 0 ? "VALIDATED" : "DRAFT",
    reliableFrom: reliable.date,
    publishFrom: reliable.effectiveDate,
    reasons,
    criteria,
    byYear: summary,
  };
}

/**
 * A retrospectively classified universe's validation (`docs/decisions/historical-universes-v1.md`
 * §2.1). Its membership is its index's, so the index's data coverage is measured exactly as for the
 * index itself and `reliableFrom` reports it; but the owner decided the universe is published from
 * the floor with that coverage **disclosed** rather than gated, as the S&P 500's own List is. What
 * gates it is its classification: enough of the index's securities classified, and a group that is
 * never empty. `warnings` carries the disclosures every surface shows.
 */
export function validateClassifiedGeneration(input: {
  readonly diagnostics: readonly ReconstitutionDiagnostic[];
  readonly latestSession: LocalDate | null;
  readonly floor: LocalDate;
  readonly securities: number;
  readonly classifiedSecurities: number;
  readonly indexName: string;
}): GenerationValidation {
  const base = validateGeneration({
    diagnostics: input.diagnostics,
    latestSession: input.latestSession,
  });
  const reasons: ValidationReason[] = base.reasons.filter(
    (reason) => reason.code === "STALE" || reason.code === "NO_RECONSTITUTIONS",
  );
  const classifiedShare =
    input.securities > 0 ? input.classifiedSecurities / input.securities : 0;
  if (classifiedShare < MIN_CLASSIFIED_SHARE) {
    reasons.push({
      code: "CLASSIFICATION_INCOMPLETE",
      classifiedShare: Math.round(classifiedShare * 10_000) / 10_000,
      minimum: MIN_CLASSIFIED_SHARE,
    });
  }
  const empty = input.diagnostics.find(
    (diagnostic) => (diagnostic.classification?.groupMembers ?? 0) === 0,
  );
  if (empty) {
    reasons.push({ code: "EMPTY_CLASSIFICATION_GROUP", date: empty.date });
  }
  const unclassified = input.securities - input.classifiedSecurities;
  const coveredFrom = groupPriceCoveredFrom(input.diagnostics);
  const firstCheckpoint = input.diagnostics.reduce<LocalDate | null>(
    (first, diagnostic) =>
      first === null || diagnostic.date < first ? diagnostic.date : first,
    null,
  );
  const warnings: ValidationWarning[] = [
    {
      code: "RETROSPECTIVE_CLASSIFICATION",
      detail:
        "Each company's current sector is applied to every date; historical reclassifications " +
        "are not reconstructed, so a company appears in the group its sector puts it in today.",
    },
    {
      code: "UNCLASSIFIED_MEMBERS",
      securities: unclassified,
      indexSecurities: input.securities,
      detail:
        unclassified === 0
          ? `Every ${input.indexName} member with stored data has a sector.`
          : `${unclassified} of ${input.securities} ${input.indexName} members with stored data ` +
            "have no provider sector; they are in no group and are listed in the report.",
    },
    {
      code: "INCOMPLETE_PRICE_COVERAGE",
      coveredFrom,
      detail:
        coveredFrom === null
          ? "No period has a stored price for 90 % of the group's members."
          : coveredFrom === firstCheckpoint
            ? "At least 90 % of the group's members have a stored price on every checkpoint."
            : `Before ${coveredFrom}, under 90 % of the group's members on some checkpoint have a ` +
              "stored price; a member without one cannot be bought on that date.",
    },
    {
      code: "SURVIVORSHIP_BIAS",
      detail:
        base.reliableFrom === null
          ? `The ${input.indexName}'s historical members are covered too sparsely to measure.`
          : `Before ${base.reliableFrom}, fewer than 90 % of the ${input.indexName}'s ` +
            "constituents on some dates have a stored price: members that left the index " +
            "without price history at the provider are missing, so early results lean toward " +
            "survivors.",
    },
  ];
  return {
    verdict: reasons.length === 0 ? "VALIDATED" : "DRAFT",
    reliableFrom: base.reliableFrom,
    publishFrom: reasons.length === 0 ? input.floor : null,
    reasons,
    warnings,
    criteria: base.criteria,
    byYear: base.byYear,
  };
}

/** The first checkpoint from which every checkpoint prices at least 90 % of the group. */
function groupPriceCoveredFrom(
  diagnostics: readonly ReconstitutionDiagnostic[],
): LocalDate | null {
  const ordered = [...diagnostics].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  let from: LocalDate | null = null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const diagnostic = ordered[index] as ReconstitutionDiagnostic;
    const group = diagnostic.classification;
    if (
      !group ||
      group.groupMembers === 0 ||
      group.groupPriced / group.groupMembers < MIN_DATA_COVERAGE
    ) {
      break;
    }
    from = diagnostic.date;
  }
  return from;
}
