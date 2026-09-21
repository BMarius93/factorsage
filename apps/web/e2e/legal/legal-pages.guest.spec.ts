import { expect, test, type Page } from "../fixtures";
import { watchForIssues } from "../utils/page-issues";

/**
 * The public legal surface, as a signed-out visitor sees it.
 *
 * Every assertion here is one of the acceptance checklist's "documents and presentation" items,
 * and each is something a reader would have to take on trust otherwise: that the pages open
 * without a session, that they carry their version and their draft status, that one footer
 * reaches every one of them, and that they fit a 390px phone.
 */

const LEGAL_PAGES = [
  { path: "/terms", heading: "Terms of Service" },
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/cookies", heading: "Cookies and browser storage" },
  { path: "/risk-disclosure", heading: "Risk disclosure" },
  {
    path: "/cancellation-and-refunds",
    heading: "Cancellation and refunds",
  },
  { path: "/contact", heading: "Contact and legal information" },
] as const;

/** Drops the Guest's expected `401` from `GET /auth/me` and the browser line it produces. */
function withoutGuestSessionProbe(lines: readonly string[]): string[] {
  return lines.filter(
    (line) =>
      !/\/auth\/me/.test(line) && !/status of 401 \(Unauthorized\)/.test(line),
  );
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("public legal pages", () => {
  for (const { path, heading } of LEGAL_PAGES) {
    test(`${path} is readable by a guest, versioned and marked draft`, async ({
      page,
    }) => {
      const issues = watchForIssues(page);

      const response = await page.goto(path);
      expect(response?.status()).toBe(200);

      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expect(page.getByTestId("legal-document")).toBeVisible();
      // The version an acceptance record would refer to is on the page itself.
      await expect(page.getByTestId("legal-document-version")).toHaveText(/\S/);
      // Nothing here is approved wording, and the page says so rather than looking published.
      await expect(page.getByTestId("legal-draft-banner")).toBeVisible();

      // No session was needed and none was offered: a policy behind a sign-in wall would fail
      // the transparency requirement it exists to satisfy.
      await expect(page).toHaveURL(new RegExp(`${path}$`));

      expect(issues.pageErrors).toEqual([]);
      // The only request a legal page makes is the shell's own session probe, and a Guest's
      // `401` from it is the documented signed-out answer rather than a failure
      // (`ai/architecture/authentication.md`, UI-040). Anything else here would mean a policy
      // page had acquired a data dependency, which is exactly what must not happen.
      expect(withoutGuestSessionProbe(issues.failedRequests)).toEqual([]);
      expect(withoutGuestSessionProbe(issues.consoleErrors)).toEqual([]);
    });
  }

  test("an expired or malformed session does not turn a policy into a sign-in prompt", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "intrinsic_auth",
        value: "not-a-real-token",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/terms");
    await expect(
      page.getByRole("heading", { level: 1, name: "Terms of Service" }),
    ).toBeVisible();
  });

  test("one footer reaches every legal destination from a product page", async ({
    page,
  }) => {
    // The Dashboard, at the product's canonical home.
    await page.goto("/");

    const footer = page.getByTestId("site-footer");
    await expect(footer).toHaveCount(1);
    for (const name of [
      "Terms",
      "Privacy",
      "Cookies",
      "Risk disclosure",
      "Cancellation & refunds",
      "Contact",
      "Storage settings",
    ]) {
      await expect(
        footer.getByRole("link", { name, exact: true }),
      ).toBeVisible();
    }

    await footer.getByRole("link", { name: "Terms", exact: true }).click();
    await expect(page).toHaveURL(/\/terms$/);
  });

  test("the sign-in screens carry the same footer", async ({ page }) => {
    // Auth screens sit outside the application shell, and are exactly where legal links usually
    // go missing — and where somebody is about to enter a contract.
    for (const path of ["/login", "/register"]) {
      await page.goto(path);
      await expect(page.getByTestId("site-footer")).toHaveCount(1);
      await expect(
        page.getByTestId("site-footer").getByRole("link", { name: "Terms" }),
      ).toBeVisible();
    }
  });

  test("every legal page fits a 390px phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const { path } of LEGAL_PAGES) {
      await page.goto(path);
      await expect(page.getByTestId("legal-document")).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });
});
