import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The password toggle's geometry, which lives entirely in CSS (AU-1).
 *
 * jsdom lays nothing out, so a rendering test cannot see the target size or whether a long
 * password runs underneath the button. Asserting the declarations is the only available guard.
 */
// Resolved from the package root: Vitest runs with `apps/web` as its working directory.
const stylesheet = readFileSync(
  resolve(process.cwd(), "src/features/auth/components/auth-form.module.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const end = stylesheet.indexOf("}", start);
  return stylesheet.slice(start, end).replace(/\s+/g, " ");
}

function px(body: string, property: string): number {
  const match = new RegExp(`(?:^|[ ;{])${property}: (\\d+)px;`).exec(body);
  expect(match, `no ${property} in px`).not.toBeNull();
  return Number(match?.[1]);
}

describe("the password toggle's geometry", () => {
  it("is at least the 24 by 24 pixel minimum target (WCAG 2.5.8)", () => {
    const toggle = ruleBody(".passwordToggle");
    expect(px(toggle, "min-height")).toBeGreaterThanOrEqual(24);
    expect(px(toggle, "min-width")).toBeGreaterThanOrEqual(24);
  });

  it("leaves the field room on the right, so text never runs under the button", () => {
    const toggle = ruleBody(".passwordToggle");
    const input = ruleBody(".passwordInput");
    // The shared field itself, not a local class composing it: the bundler does not resolve a
    // composition chain, and the field rendered unstyled in the browser.
    expect(input).toContain(
      'composes: input from "../../../components/ui/forms.module.css";',
    );
    expect(px(input, "padding-right")).toBeGreaterThanOrEqual(
      px(toggle, "min-width") + px(toggle, "right"),
    );
  });

  it("shows keyboard focus with the shared ring", () => {
    expect(ruleBody(".passwordToggle:focus-visible")).toContain(
      "box-shadow: var(--focus-ring);",
    );
  });
});
