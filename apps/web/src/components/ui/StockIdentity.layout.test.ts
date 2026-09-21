import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The parts of the mark's layout contract that live entirely in CSS.
 *
 * jsdom applies no stylesheet and resolves no CSS Module, so a rendering test cannot see any of
 * this — yet each rule below is a promise the product makes about how a stock looks, and each one
 * was broken at some point in this file's history. Asserting the declarations is the only
 * available guard; the rendered behaviour they produce was verified in a real browser.
 */
// Resolved from the package root: Vitest runs with `apps/web` as its working directory, and
// `import.meta.url` here is the dev server's transform URL rather than a file path.
const stylesheet = readFileSync(
  resolve(process.cwd(), "src/components/ui/StockIdentity.module.css"),
  "utf8",
);

/** The declarations inside one rule, whitespace collapsed. */
function ruleBody(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const end = stylesheet.indexOf("}", start);
  return stylesheet.slice(start, end).replace(/\s+/g, " ");
}

describe("the mark's layout contract", () => {
  it("fixes both dimensions at every size, so the box exists before the image does", () => {
    for (const size of ["sm", "md", "lg"]) {
      const body = ruleBody(`.logo[data-size="${size}"]`);
      expect(body, size).toMatch(/width: \d+px/);
      expect(body, size).toMatch(/height: \d+px/);
    }
  });

  it("keeps the sizes contextual rather than making every mark identical", () => {
    // Compact dropdown row, collection row, and the one page-level identity.
    expect(ruleBody('.logo[data-size="sm"]')).toContain("width: 28px");
    expect(ruleBody('.logo[data-size="md"]')).toContain("width: 32px");
    expect(ruleBody('.logo[data-size="lg"]')).toContain("width: 40px");
    // …which grows on a wide viewport, the way V1's did.
    expect(stylesheet).toMatch(
      /@media \(min-width: 880px\) \{\s*\.logo\[data-size="lg"\] \{\s*width: 44px/,
    );
  });

  it("contains the mark rather than cropping it to fill the box", () => {
    const body = ruleBody(".logoImage");
    expect(body).toContain("object-fit: contain");
    expect(body).not.toContain("cover");
    // The image fills the box the container already sized; it never sizes the container.
    expect(body).toContain("width: 100%");
    expect(body).toContain("height: 100%");
  });

  it("aligns the identity explicitly, so a row cannot change height when a mark arrives", () => {
    // An inline-flex box takes its baseline from its first item. The monogram has a text
    // baseline and an image has none, so on the default `baseline` the row grew at the moment
    // the image loaded — 1.5px per row, measured on a thirty-stock list.
    expect(ruleBody(".identity")).toContain("vertical-align: middle");
  });

  it("takes the dark plate from a token rather than a local colour", () => {
    expect(ruleBody('.logo[data-bright="true"]')).toContain(
      "var(--color-surface-contrast)",
    );
    // The absolute rule: a hex colour lives only in `tokens.css`.
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
