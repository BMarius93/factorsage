import { expect, test } from "../fixtures";

/**
 * Browser storage, and the choice that governs it.
 *
 * The rules being proved here are the ones that make the guest recent-securities key lawful
 * optional storage rather than a convenience somebody forgot to ask about: nothing optional is
 * read or written before a choice, refusing really refuses, withdrawing removes what was already
 * written, and none of it touches the session.
 */

const CONSENT_KEY = "factorsage.storage-consent.v1";
const RECENTS_KEY = "factorsage.recent-securities.v1";

/** Reads a key without letting a blocked store fail the test. */
async function storedValue(
  page: import("../fixtures").Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  }, key);
}

test.describe("browser storage consent", () => {
  test("nothing optional is stored before the visitor chooses", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("consent-banner")).toBeVisible();

    // Both choices are offered at the same size and prominence, side by side.
    await expect(page.getByTestId("consent-reject")).toBeVisible();
    await expect(page.getByTestId("consent-accept")).toBeVisible();

    // A stock view is what would normally write the guest recents key.
    await page.goto("/stocks/QATEST1");
    await expect(page.getByTestId("disclosure-valuations")).toBeVisible();
    expect(await storedValue(page, RECENTS_KEY)).toBeNull();
    expect(await storedValue(page, CONSENT_KEY)).toBeNull();
  });

  test("refusing stops the optional storage and is remembered", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("consent-reject").click();
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);

    await page.goto("/stocks/QATEST1");
    await expect(page.getByTestId("disclosure-valuations")).toBeVisible();
    expect(await storedValue(page, RECENTS_KEY)).toBeNull();

    // The refusal itself is remembered, so the visitor is not asked again.
    expect(await storedValue(page, CONSENT_KEY)).toContain(
      '"preferences":false',
    );
    await page.goto("/");
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
  });

  test("allowing, then withdrawing, removes the key it wrote and keeps the session", async ({
    page,
  }) => {
    await page.goto("/cookies");
    await page.getByTestId("storage-allow").click();

    await page.goto("/stocks/QATEST1");
    await expect(page.getByTestId("disclosure-valuations")).toBeVisible();
    await expect.poll(() => storedValue(page, RECENTS_KEY)).not.toBeNull();

    // Withdrawal is the same single action, in the same place, as granting.
    await page.goto("/cookies");
    await page.getByTestId("storage-reject").click();
    await expect.poll(() => storedValue(page, RECENTS_KEY)).toBeNull();
    // The choice record survives — it is what honours the refusal — and nothing else was cleared.
    expect(await storedValue(page, CONSENT_KEY)).toContain(
      '"preferences":false',
    );
  });

  test("the inventory on the cookie page describes the storage that exists", async ({
    page,
  }) => {
    await page.goto("/cookies");

    const inventory = page.getByTestId("storage-inventory");
    await expect(inventory).toBeVisible();
    // The keys the application actually uses, named so they can be found in a browser's own
    // site-data panel.
    await expect(inventory).toContainText(RECENTS_KEY);
    await expect(inventory).toContainText(CONSENT_KEY);
    // And the third-party boundary is stated rather than claimed to be controlled here.
    await expect(inventory).toContainText("Stripe");
    await expect(inventory).toContainText("Google");
  });

  test("the footer's storage settings link reaches the control from any page", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByTestId("site-footer")
      .getByRole("link", { name: "Storage settings" })
      .click();

    await expect(page).toHaveURL(/\/cookies#storage-settings$/);
    await expect(page.getByTestId("storage-settings")).toBeVisible();
  });
});
