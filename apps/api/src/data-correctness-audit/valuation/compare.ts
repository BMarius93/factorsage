import {
  oracleCompare,
  oracleExactDouble,
  oracleNearestDouble,
  oracleRational,
  type OracleRational,
  type OracleValuationOutcome,
  type OracleValuationRatioId,
  type OracleValuationReason,
} from "../oracle/valuation-ratios";

/**
 * How one production cell compares with the reference: the audit's five classes.
 *
 * - `AVAILABLE_MATCH`: both available, the product's double within the named tolerance of the
 *   exact value.
 * - `EXPECTED_UNAVAILABLE`: both unavailable.
 * - `FALSE_AVAILABLE`: the product shows a reading the reference withholds.
 * - `FALSE_UNAVAILABLE`: the product withholds a reading the reference shows.
 * - `VALUE_MISMATCH`: both available, the product's double outside the tolerance.
 */
export type CellClass =
  | "AVAILABLE_MATCH"
  | "EXPECTED_UNAVAILABLE"
  | "FALSE_AVAILABLE"
  | "FALSE_UNAVAILABLE"
  | "VALUE_MISMATCH";

/**
 * The tolerance a correct double may sit from the exact value, and why.
 *
 * The product computes `MC = close · K · shares` and `(MC + addend) / denominator` in IEEE-754
 * doubles from inputs that are themselves doubles: the close (a `DECIMAL(20,8)` read into a
 * double), each measured price ratio (`DECIMAL(24,12)`), the share count and net debt (JSON
 * numbers). The window sums are exact decimal sums rounded once (`exactDecimalSum`). Each of those
 * conversions and each of the `m` multiplications of `K`, the two of `MC`, the addition and the
 * division introduces a relative error of at most `u = 2^-53`, so the absolute error is at most
 * `(m + 6) · u · (|MC| + |addend|) / denominator + 2u · |value|` to first order. The tolerance
 * allows 32 times that first-order bound (`2^-48` per term): still about `3.6e-15` of the
 * magnitudes involved, a billion times smaller than any wrong window, wrong field, wrong share count
 * or wrong factor could produce, so no logic error fits inside it. The bound scales with
 * `|MC| + |addend|` rather than with the value, because an enterprise value that nearly cancels
 * (net cash close to the market capitalisation) loses relative, not absolute, precision.
 */
export function valuationTolerance(
  outcome: Extract<OracleValuationOutcome, { available: true }>,
): OracleRational {
  const { terms } = outcome;
  const magnitude = oracleRational(
    (abs(terms.marketCapitalisation.n) * terms.addend.d +
      abs(terms.addend.n) * terms.marketCapitalisation.d) *
      terms.denominator.d,
    terms.marketCapitalisation.d * terms.addend.d * terms.denominator.n,
  );
  const operations = BigInt(terms.basisFactorCount + 6);
  const scaled = oracleRational(
    magnitude.n * operations * outcome.value.d +
      abs(outcome.value.n) * 2n * magnitude.d,
    magnitude.d * outcome.value.d,
  );
  return oracleRational(scaled.n * 32n, scaled.d * (1n << 53n));
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export type CellComparison = {
  cls: CellClass;
  /** `|product − exact|`, when both are available. */
  absoluteDifference?: number;
  /** `|product − exact| / |exact|`, when both are available and the exact value is not zero. */
  relativeDifference?: number;
  /** The difference over its tolerance (`<= 1` passes), when both are available. */
  toleranceUsed?: number;
  /** The tolerance over `|exact|` (`Infinity` for an exact zero), when both are available. */
  relativeTolerance?: number;
};

/** Compares one product double (NaN = unavailable) with the reference outcome. */
export function compareCell(
  product: number,
  outcome: OracleValuationOutcome,
): CellComparison {
  const productAvailable = !Number.isNaN(product);
  if (!outcome.available) {
    return {
      cls: productAvailable ? "FALSE_AVAILABLE" : "EXPECTED_UNAVAILABLE",
    };
  }
  if (!productAvailable) {
    return { cls: "FALSE_UNAVAILABLE" };
  }
  if (!Number.isFinite(product)) {
    return { cls: "VALUE_MISMATCH" };
  }
  const exactProduct = oracleExactDouble(product);
  const difference = oracleRational(
    exactProduct.n * outcome.value.d - outcome.value.n * exactProduct.d,
    exactProduct.d * outcome.value.d,
  );
  const absolute =
    difference.n < 0n ? { n: -difference.n, d: difference.d } : difference;
  const tolerance = valuationTolerance(outcome);
  const within = oracleCompare(absolute, tolerance) <= 0;
  const absoluteDifference = oracleNearestDouble(absolute);
  const exactMagnitude = Math.abs(outcome.double);
  return {
    cls: within ? "AVAILABLE_MATCH" : "VALUE_MISMATCH",
    absoluteDifference,
    ...(exactMagnitude > 0
      ? { relativeDifference: absoluteDifference / exactMagnitude }
      : {}),
    relativeTolerance:
      exactMagnitude > 0
        ? oracleNearestDouble(tolerance) / exactMagnitude
        : Infinity,
    toleranceUsed:
      tolerance.n === 0n
        ? absolute.n === 0n
          ? 0
          : Infinity
        : oracleNearestDouble(
            oracleRational(absolute.n * tolerance.d, absolute.d * tolerance.n),
          ),
  };
}

/** Counts per ratio, class and reason, and the numeric differences of every match. */
export class ComparisonTally {
  readonly cells = new Map<OracleValuationRatioId, Record<CellClass, number>>();
  readonly unavailableByReason = new Map<
    OracleValuationRatioId,
    Map<OracleValuationReason, number>
  >();
  /** Cells whose only failing rule is this one: what the rule alone withholds. */
  readonly soleReason = new Map<
    OracleValuationRatioId,
    Map<OracleValuationReason, number>
  >();
  readonly relativeDifferences: number[] = [];
  maxAbsoluteDifference = 0;
  maxRelativeDifference = 0;
  maxToleranceUsed = 0;
  /** Available cells whose double equals the exact value itself (no rounding at all). */
  exactMatches = 0;
  /**
   * Compared cells by how loose their tolerance is relative to the exact value: how many readings a
   * wrong value of that relative size could hide in. Without net cash the tolerance is
   * `(m + 8) · 2^-48` of the value, under `1e-13` for up to 20 basis factors; only an enterprise
   * value whose net cash approaches the market capitalisation has a wider one.
   */
  readonly relativeToleranceBuckets: Record<string, number> = {
    "<=1e-13": 0,
    "<=1e-9": 0,
    "<=1e-6": 0,
    "<=1e-3": 0,
    ">1e-3": 0,
  };
  readonly failures: {
    key: string;
    ratio: OracleValuationRatioId;
    cls: CellClass;
    product: number;
    expected: string;
    reasons?: readonly OracleValuationReason[];
  }[] = [];

  record(
    key: string,
    ratio: OracleValuationRatioId,
    product: number,
    outcome: OracleValuationOutcome,
    keepFailures = 200,
  ): CellComparison {
    const comparison = compareCell(product, outcome);
    const counts =
      this.cells.get(ratio) ??
      ({
        AVAILABLE_MATCH: 0,
        EXPECTED_UNAVAILABLE: 0,
        FALSE_AVAILABLE: 0,
        FALSE_UNAVAILABLE: 0,
        VALUE_MISMATCH: 0,
      } satisfies Record<CellClass, number>);
    counts[comparison.cls] += 1;
    this.cells.set(ratio, counts);
    if (!outcome.available) {
      const reasons = this.unavailableByReason.get(ratio) ?? new Map();
      reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
      this.unavailableByReason.set(ratio, reasons);
      if (outcome.failing.length === 1) {
        const sole = this.soleReason.get(ratio) ?? new Map();
        sole.set(outcome.reason, (sole.get(outcome.reason) ?? 0) + 1);
        this.soleReason.set(ratio, sole);
      }
    }
    if (comparison.absoluteDifference !== undefined) {
      if (comparison.absoluteDifference === 0) {
        this.exactMatches += 1;
      }
      this.maxAbsoluteDifference = Math.max(
        this.maxAbsoluteDifference,
        comparison.absoluteDifference,
      );
      if (comparison.relativeDifference !== undefined) {
        this.relativeDifferences.push(comparison.relativeDifference);
        this.maxRelativeDifference = Math.max(
          this.maxRelativeDifference,
          comparison.relativeDifference,
        );
      }
      this.maxToleranceUsed = Math.max(
        this.maxToleranceUsed,
        comparison.toleranceUsed ?? 0,
      );
      const loose = comparison.relativeTolerance ?? Infinity;
      const bucket =
        loose <= 1e-13
          ? "<=1e-13"
          : loose <= 1e-9
            ? "<=1e-9"
            : loose <= 1e-6
              ? "<=1e-6"
              : loose <= 1e-3
                ? "<=1e-3"
                : ">1e-3";
      this.relativeToleranceBuckets[bucket] =
        (this.relativeToleranceBuckets[bucket] ?? 0) + 1;
    }
    if (
      comparison.cls !== "AVAILABLE_MATCH" &&
      comparison.cls !== "EXPECTED_UNAVAILABLE" &&
      this.failures.length < keepFailures
    ) {
      this.failures.push({
        key,
        ratio,
        cls: comparison.cls,
        product,
        expected: outcome.available
          ? `${outcome.value.n}/${outcome.value.d} (${outcome.double})`
          : `unavailable: ${outcome.failing.join(",")}`,
        ...(outcome.available ? {} : { reasons: outcome.failing }),
      });
    }
    return comparison;
  }

  total(cls?: CellClass): number {
    let total = 0;
    for (const counts of this.cells.values()) {
      for (const [key, value] of Object.entries(counts) as [
        CellClass,
        number,
      ][]) {
        if (cls === undefined || key === cls) {
          total += value;
        }
      }
    }
    return total;
  }

  percentile(fraction: number): number {
    if (this.relativeDifferences.length === 0) {
      return 0;
    }
    const sorted = Float64Array.from(this.relativeDifferences).sort();
    const index = Math.min(
      sorted.length - 1,
      Math.floor(fraction * (sorted.length - 1)),
    );
    return sorted[index] as number;
  }

  summary(): Record<string, unknown> {
    const perRatio: Record<string, unknown> = {};
    for (const [ratio, counts] of this.cells) {
      perRatio[ratio] = {
        ...counts,
        available:
          counts.AVAILABLE_MATCH +
          counts.VALUE_MISMATCH +
          counts.FALSE_AVAILABLE,
        unavailableByReference:
          counts.EXPECTED_UNAVAILABLE + counts.FALSE_AVAILABLE,
        reasons: Object.fromEntries(this.unavailableByReason.get(ratio) ?? []),
        soleReasons: Object.fromEntries(this.soleReason.get(ratio) ?? []),
      };
    }
    return {
      comparisons: this.total(),
      AVAILABLE_MATCH: this.total("AVAILABLE_MATCH"),
      EXPECTED_UNAVAILABLE: this.total("EXPECTED_UNAVAILABLE"),
      FALSE_AVAILABLE: this.total("FALSE_AVAILABLE"),
      FALSE_UNAVAILABLE: this.total("FALSE_UNAVAILABLE"),
      VALUE_MISMATCH: this.total("VALUE_MISMATCH"),
      exactValueMatches: this.exactMatches,
      maxAbsoluteDifference: this.maxAbsoluteDifference,
      maxRelativeDifference: this.maxRelativeDifference,
      maxToleranceUsed: this.maxToleranceUsed,
      relativeToleranceBuckets: this.relativeToleranceBuckets,
      relativeDifferenceP50: this.percentile(0.5),
      relativeDifferenceP95: this.percentile(0.95),
      relativeDifferenceP99: this.percentile(0.99),
      perRatio,
    };
  }
}
