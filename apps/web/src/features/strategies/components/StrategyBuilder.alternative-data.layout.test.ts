import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The configured first operand's own line, at both widths.
 *
 * Responsive behaviour is part of acceptance rather than a later cleanup (`AGENTS.md` frontend rules),
 * and the two things that can go wrong here are invisible to a rendering test in jsdom: the summary
 * could sit in the row's reserved connector column on a desktop, or it could stop spanning the row on
 * a phone and squeeze a control. Both are decided entirely by two `grid-column` declarations, so they
 * are asserted as declarations.
 */
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "StrategyBuilder.module.css"),
  "utf8",
);

/** The body of one rule, from a `.selector {` to its closing brace. */
function ruleBody(selector: string, after = 0): string {
  const start = css.indexOf(`${selector} {`, after);
  expect(start, `${selector} is declared`).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("the alternative-data operand summary", () => {
  it("spans the whole rule row on a phone, so no control is squeezed", () => {
    expect(ruleBody(".operandConfig")).toContain("grid-column: 1 / -1");
  });

  it("starts under the fields on a desktop, not under the reserved connector column", () => {
    const desktop = css.indexOf("@media (min-width: 600px)");
    expect(desktop).toBeGreaterThan(-1);
    // The same column the row's own error message uses, which is the established alignment.
    expect(ruleBody(".operandConfig", desktop)).toContain("grid-column: 2 / -1");
    expect(ruleBody(".rowError", desktop)).toContain("grid-column: 2 / -1");
  });

  it("wraps rather than overflowing, because a group name can be long", () => {
    const body = ruleBody(".operandConfig");
    expect(body).toContain("flex-wrap: wrap");
    expect(body).toContain("min-width: 0");
  });

  it("truncates the summary itself instead of widening the row", () => {
    const body = ruleBody(".operandConfiguration");
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
  });
});

describe("the Category / Metric / Condition / Value fields", () => {
  it("lay out by the width the list actually has, not by the viewport", () => {
    // The same list is full-width on a tablet and two-thirds of the page beside the explanation
    // panel, so only its own width can say whether four controls fit on one line.
    expect(ruleBody(".predicateList")).toContain(
      "container: predicate-list / inline-size",
    );
  });

  it("read as two short lines in a narrow list, so no control is squeezed", () => {
    expect(ruleBody(".predicateFields")).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);",
    );
  });

  it("read as one sentence once the list is wide enough for all four", () => {
    const wide = css.indexOf("@container predicate-list (min-width: 680px)");
    expect(wide).toBeGreaterThan(-1);
    const body = ruleBody(".predicateFields", wide);
    expect(body.match(/minmax\(/g)).toHaveLength(4);
  });
});
