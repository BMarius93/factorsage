import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The parts of the plan comparison's look that live entirely in CSS.
 *
 * jsdom applies no stylesheet and resolves no `composes`, so a rendering test cannot see whether
 * the cadence toggle wears the shared segmented control or a slab of its own. Asserting the
 * declarations is the only available guard.
 */
// Resolved from the package root: Vitest runs with `apps/web` as its working directory.
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");
const billing = read("src/features/billing/components/BillingPage.module.css");
const segmented = read("src/components/ui/SegmentedControl.module.css");

/** The declarations inside the first rule for `selector`, whitespace collapsed. */
function ruleBody(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const end = stylesheet.indexOf("}", start);
  return stylesheet.slice(start, end).replace(/\s+/g, " ");
}

describe("the cadence toggle's look (PR-2)", () => {
  it("is the shared SegmentedControl's, composed rather than restated", () => {
    expect(ruleBody(billing, ".segmented")).toContain(
      'composes: group from "../../../components/ui/SegmentedControl.module.css";',
    );
    expect(ruleBody(billing, ".segment")).toContain(
      'composes: option from "../../../components/ui/SegmentedControl.module.css";',
    );
  });

  it("selects by the shared control's tint, never a solid primary slab of its own", () => {
    // The chosen option is the shared control's `data-active` rule: a tint and primary ink.
    const active = ruleBody(segmented, '.option[data-active="true"]');
    expect(active).toContain("background: var(--color-surface-selected);");
    expect(active).toContain("color: var(--color-primary-ink);");
    // Nothing local re-paints the chosen cadence.
    expect(billing).not.toMatch(/\.segment\[data-(selected|active)/);
    expect(billing).not.toContain("--color-text-on-primary");
  });
});

describe("the yearly saving", () => {
  it("wears the brand accent, never the colour that means financial state", () => {
    // `ai/architecture/v1-visual-parity.md`: green and red mean financial and operational state.
    expect(ruleBody(billing, ".priceSaving")).toContain("color: var(--color-primary-ink);");
    expect(ruleBody(billing, ".segmentTag")).toContain("color: var(--color-primary-ink);");
    expect(billing).not.toMatch(/var\(--color-positive/);
  });
});

describe("a row a plan does not include (PR-1)", () => {
  it("is muted and drawn with its own mark, not only a different colour", () => {
    expect(ruleBody(billing, '.feature[data-included="false"]')).toContain(
      "color: var(--color-text-muted);",
    );
    expect(ruleBody(billing, ".excluded")).toContain("width: 16px;");
  });
});
