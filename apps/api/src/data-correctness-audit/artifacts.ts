import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes the audit's evidence under `artifacts/data-correctness-audit/`.
 *
 * Every file is JSON or Markdown so a reviewer — or another tool — can read it without this code.
 */
export class AuditWriter {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  path(relative: string): string {
    return join(this.root, relative);
  }

  writeJson(relative: string, value: unknown): void {
    const target = this.path(relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
  }

  writeText(relative: string, value: string): void {
    const target = this.path(relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value.endsWith("\n") ? value : `${value}\n`);
  }
}

/** NaN and infinities are not JSON; the audit writes them as explicit strings rather than null. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  if (value instanceof Set) {
    return [...value];
  }
  return value;
}

/** One section's machine-readable outcome, as the manifest aggregates it. */
export type SectionResult = {
  section: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  comparisons: number;
  passed: number;
  failed: number;
  skipped: number;
  tolerancePasses: number;
  independentOracle: boolean;
  endToEnd: boolean;
  detail: Record<string, unknown>;
  notes: string[];
};
