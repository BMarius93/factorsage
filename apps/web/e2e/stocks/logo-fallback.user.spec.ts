import { expect, test } from "@playwright/test";
import { serveLogosAsMissing } from "../utils/logos";

/**
 * A security with no upstream mark is a quiet monogram, not a console error (UX-005).
 *
 * The logo endpoint answers a miss with `204 No Content`; this spec serves exactly that response
 * in the browser (no provider traffic) and proves the browser reports nothing and the component
 * falls back — on a first load and again when the miss comes from the HTTP cache. It runs signed
 * in, so the console carries nothing but what the page itself produces (a Guest's session probe
 * answers `401` by design).
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`.
 */
test("renders a monogram for a missing logo with a clean console, cold and cached", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") {
      failures.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  await serveLogosAsMissing(page);

  for (const pass of ["first load", "reload"]) {
    if (pass === "first load") {
      await page.goto("/dashboard");
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

  expect(consoleErrors).toEqual([]);
  expect(failures).toEqual([]);
});
