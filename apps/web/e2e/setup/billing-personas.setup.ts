import { BILLING_PERSONA_LIST } from "@intrinsic/testing/billing-personas";
import { expect, test as setup } from "../fixtures";
import { billingPersonaCredentials } from "../utils/billing-personas";

/**
 * Signs each billing persona in once, through the product's own form, and saves its storage state.
 *
 * The billing-persona counterpart of `auth.setup.ts`, and deliberately a separate file driven by a
 * separate registry: the ordinary suite's setup knows nothing about these accounts and never signs
 * them in. The state files are git-ignored — they hold a live session cookie.
 *
 * A failure here almost always means the personas are not seeded in the database this stack
 * serves, or were seeded without the shared password.
 */
for (const persona of BILLING_PERSONA_LIST) {
  setup(`authenticate ${persona.name}`, async ({ page }) => {
    const credentials = billingPersonaCredentials(persona);

    await page.goto("/login");
    await page.getByLabel("Email").fill(credentials.email);
    await page.getByLabel("Password").fill(credentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByTestId("account-menu-trigger"),
      `${persona.name} could not sign in. Seed the billing personas into the test database ` +
        "first: `pnpm qa:billing:seed -- --database test`, with QA_BILLING_PASSWORD set.",
    ).toBeVisible();
    await page.context().storageState({ path: persona.storageState });
  });
}
