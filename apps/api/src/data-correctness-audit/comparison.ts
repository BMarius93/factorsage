import { dec } from "./oracle/decimal";

/**
 * One ledger of comparisons, shared by every audit section.
 *
 * A comparison is PASS only when expected and actual are equal under the rule named for that field;
 * a tolerance, where one is used, is carried on the comparison itself so a reader can see every
 * number that did not pass on exact equality. SKIPPED is its own outcome and is never folded into
 * PASS.
 */

export type ComparisonRule =
  | "exact-text"
  | "exact-decimal"
  | "exact-number"
  | { tolerance: number; justification: string };

export type Difference = {
  path: string;
  expected: unknown;
  actual: unknown;
  rule: string;
  difference?: number;
};

export class ComparisonLedger {
  compared = 0;
  passed = 0;
  failed = 0;
  skipped = 0;
  tolerancePasses = 0;
  readonly differences: Difference[] = [];
  readonly skips: { path: string; reason: string }[] = [];
  private readonly categories = new Map<
    string,
    { compared: number; failed: number; skipped: number }
  >();

  constructor(private readonly maxDifferences = 200) {}

  private category(name: string): {
    compared: number;
    failed: number;
    skipped: number;
  } {
    let entry = this.categories.get(name);
    if (!entry) {
      entry = { compared: 0, failed: 0, skipped: 0 };
      this.categories.set(name, entry);
    }
    return entry;
  }

  byCategory(): Record<
    string,
    { compared: number; failed: number; skipped: number }
  > {
    return Object.fromEntries([...this.categories.entries()].sort());
  }

  skip(category: string, path: string, reason: string): void {
    this.skipped += 1;
    this.category(category).skipped += 1;
    if (this.skips.length < this.maxDifferences) {
      this.skips.push({ path, reason });
    }
  }

  check(
    category: string,
    path: string,
    expected: unknown,
    actual: unknown,
    rule: ComparisonRule,
  ): boolean {
    this.compared += 1;
    const bucket = this.category(category);
    bucket.compared += 1;
    let equal: boolean;
    let difference: number | undefined;
    let ruleName: string;
    if (rule === "exact-text") {
      ruleName = rule;
      equal = expected === actual;
    } else if (rule === "exact-decimal") {
      ruleName = rule;
      if (
        expected === null ||
        actual === null ||
        expected === undefined ||
        actual === undefined
      ) {
        equal = (expected ?? null) === (actual ?? null);
      } else {
        const left = dec(String(expected));
        const right = dec(String(actual));
        equal = left.eq(right);
        if (!equal) {
          difference = Number(right.minus(left).toString());
        }
      }
    } else if (rule === "exact-number") {
      ruleName = rule;
      equal = Object.is(expected, actual) || expected === actual;
    } else {
      ruleName = `tolerance ${rule.tolerance} (${rule.justification})`;
      if (typeof expected !== "number" || typeof actual !== "number") {
        equal = (expected ?? null) === (actual ?? null);
      } else {
        difference = actual - expected;
        const exact = expected === actual;
        equal = exact || Math.abs(difference) <= rule.tolerance;
        if (equal && !exact) {
          this.tolerancePasses += 1;
        }
      }
    }
    if (equal) {
      this.passed += 1;
    } else {
      this.failed += 1;
      bucket.failed += 1;
      if (this.differences.length < this.maxDifferences) {
        this.differences.push({
          path,
          expected,
          actual,
          rule: ruleName,
          difference,
        });
      }
    }
    return equal;
  }

  merge(other: ComparisonLedger): void {
    this.compared += other.compared;
    this.passed += other.passed;
    this.failed += other.failed;
    this.skipped += other.skipped;
    this.tolerancePasses += other.tolerancePasses;
    for (const [name, value] of Object.entries(other.byCategory())) {
      const bucket = this.category(name);
      bucket.compared += value.compared;
      bucket.failed += value.failed;
      bucket.skipped += value.skipped;
    }
  }

  totals(): {
    compared: number;
    passed: number;
    failed: number;
    skipped: number;
    tolerancePasses: number;
  } {
    return {
      compared: this.compared,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      tolerancePasses: this.tolerancePasses,
    };
  }
}
