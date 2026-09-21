import { expect, test } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * A security with no upstream mark is a quiet monogram, not a console error (UX-005).
 *
 * The logo endpoint answers a miss with `204 No Content`; the shared stub in `fixtures.ts` serves
 * exactly that response in the browser for every spec (no provider traffic), and this spec proves
 * the stub is really what answered, that the browser reports nothing, and that the component falls
 * back — on a first load and again when the miss comes from the HTTP cache. It runs signed in, so
 * the console carries nothing but what the page itself produces (a Guest's session probe answers
 * `401` by design).
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */
test("renders a monogram for a missing logo with a clean console, cold and cached", async ({
  page,
  logoRequests,
}) => {
  const issues = watchForIssues(page);

  for (const pass of ["first load", "reload"]) {
    if (pass === "first load") {
      await page.goto("/");
    } else {
      await page.reload();
    }
    const identity = page
      .getByTestId("dashboard-stock")
      .filter({ hasText: "QATEST1" })
      .first();
    await expect(identity, pass).toBeVisible();
    // The image gave way to the ticker's initials; no empty box, no broken-image glyph.
    await expect(identity.locator("img"), pass).toHaveCount(0);
    await expect(identity.locator("[data-monogram]"), pass).toHaveAttribute(
      "data-monogram",
      "QA",
    );
  }

  // The monogram came from the shared stub's 204, not from a request that never happened.
  expect(logoRequests).toContain("QATEST1");
  expect(issues.consoleErrors).toEqual([]);
  expect(issues.pageErrors).toEqual([]);
  expect(issues.failedRequests).toEqual([]);
});
